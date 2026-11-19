#import "RBVoiceAudio.h"
#import "RBVoiceEcho.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"
#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <stdatomic.h>

#if !defined(ROKBOT_VOICE_AEC3)
BOOL RBVoiceAudioAvailable(void) { return NO; }
#else
// The original module retains its microphone tap, player, resampler and UI.
// AEC3 uses the same engine's actual output to remove residual speaker echo.
static BOOL RBVoiceAudioInstalled;
static BOOL (*RBOriginalEngineStart)(AVAudioEngine *, SEL, NSError **);
static void (*RBOriginalTap)(AVAudioNode *, SEL, AVAudioNodeBus, AVAudioFrameCount, AVAudioFormat *, AVAudioNodeTapBlock);
static __weak AVAudioEngine *RBCallEngine;
static __weak id RBCallSocket;
static void (*RBOriginalSocketOpen)(id, SEL);
static const void *RBEchoKey = &RBEchoKey;
@interface RBVoiceAudioContext : NSObject { @public atomic_bool failureQueued; }
@property(atomic,strong) RBVoiceEcho *echo;
@property(nonatomic,strong) AVAudioPCMBuffer *captureBuffer;
@property(nonatomic,weak) AVAudioMixerNode *referenceNode;
- (RBVoiceEcho *)echoForFormat:(AVAudioFormat *)format;
- (AVAudioPCMBuffer *)copyCapture:(AVAudioPCMBuffer *)source;
@end
@implementation RBVoiceAudioContext
- (AVAudioPCMBuffer *)copyCapture:(AVAudioPCMBuffer *)source {
  AVAudioPCMBuffer *copy = self.captureBuffer;
  if (!copy || ![copy.format isEqual:source.format] || copy.frameCapacity < source.frameLength) {
    copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:source.format frameCapacity:source.frameLength];
    self.captureBuffer = copy;
  }
  if (!copy) return nil;
  copy.frameLength = source.frameLength;
  const AudioBufferList *input = source.audioBufferList;
  AudioBufferList *output = copy.mutableAudioBufferList;
  if (input->mNumberBuffers != output->mNumberBuffers) return nil;
  for (UInt32 i = 0; i < input->mNumberBuffers; i++) {
    if (input->mBuffers[i].mDataByteSize > output->mBuffers[i].mDataByteSize) return nil;
    memcpy(output->mBuffers[i].mData, input->mBuffers[i].mData, input->mBuffers[i].mDataByteSize);
  }
  return copy;
}
- (RBVoiceEcho *)echoForFormat:(AVAudioFormat *)format {
  RBVoiceEcho *echo = self.echo;
  if (echo.sampleRate == (NSInteger)llround(format.sampleRate)) return echo;
  @synchronized (self) {
    echo = self.echo;
    if (echo.sampleRate != (NSInteger)llround(format.sampleRate)) {
      echo = [[RBVoiceEcho alloc] initWithInputFormat:format]; self.echo = echo;
    }
  }
  return echo;
}
@end

static BOOL RBIsVoiceSession(void) {
  return [AVAudioSession.sharedInstance.mode isEqual:AVAudioSessionModeVoiceChat];
}
static RBVoiceAudioContext *RBContextForEngine(AVAudioEngine *engine) {
  RBVoiceAudioContext *context = objc_getAssociatedObject(engine, RBEchoKey);
  if (!context) {
    context = [RBVoiceAudioContext new];
    objc_setAssociatedObject(engine, RBEchoKey, context, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return context;
}
static void RBOpenVoiceSocket(id socket, SEL selector) {
  NSURL *url = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(url));
  if ([url.path isEqualToString:@"/local/voice/realtime"]) RBCallSocket = socket;
  RBOriginalSocketOpen(socket, selector);
}
static void RBFailVoiceAudio(AVAudioEngine *engine, RBVoiceAudioContext *context) {
  if (atomic_exchange(&context->failureQueued, true)) return;
  // Audio taps must not stop their own engine. The original realtime socket's
  // close event already ends the call and updates the original React UI.
  id socket = RBCallSocket;
  dispatch_async(dispatch_get_main_queue(), ^{
    [engine stop];
    if ([socket respondsToSelector:@selector(closeWithCode:reason:)]) {
      ((void (*)(id, SEL, NSInteger, NSString *))objc_msgSend)(socket,
        @selector(closeWithCode:reason:), 1011,
        RBL(@"语音处理已中断，请重新连接。", @"Voice audio stopped. Please reconnect."));
    }
    RBDiagnosticsEvent(@"voice.audio.unavailable", @{});
  });
}
static BOOL RBConfigureVoiceEngine(AVAudioEngine *engine) {
  if (!RBIsVoiceSession() || !engine.inputNode.isVoiceProcessingEnabled) return NO;
  engine.inputNode.voiceProcessingBypassed = NO;
  RBVoiceAudioContext *context = RBContextForEngine(engine);
  RBVoiceEcho *echo = [context echoForFormat:[engine.inputNode outputFormatForBus:0]];
  if (!echo) return NO;
  AVAudioMixerNode *mixer = engine.mainMixerNode;
  if (context.referenceNode != mixer) {
    RBOriginalTap(mixer, @selector(installTapOnBus:bufferSize:format:block:), 0, 480, nil,
      ^(AVAudioPCMBuffer *buffer, AVAudioTime *time) { [context.echo render:buffer atTime:time]; });
    context.referenceNode = mixer;
  }
  RBCallEngine = engine;
  return YES;
}
static BOOL RBStartVoiceEngine(AVAudioEngine *engine, SEL selector, NSError **error) {
  BOOL voice = RBIsVoiceSession(), configured = voice && RBConfigureVoiceEngine(engine);
  if (configured) atomic_store(&RBContextForEngine(engine)->failureQueued, false);
  if (voice && !configured) {
    if (error) *error = [NSError errorWithDomain:@"RokBotVoiceAudio" code:1
      userInfo:@{NSLocalizedDescriptionKey:RBL(@"无法启动语音处理。", @"Voice audio processing could not start.")}];
    return NO;
  }
  BOOL started = RBOriginalEngineStart(engine, selector, error);
  if (configured) {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    RBDiagnosticsEvent(@"voice.audio.native", @{
      @"running":@(started), @"voiceProcessing":@(engine.inputNode.isVoiceProcessingEnabled),
      @"bypassed":@(engine.inputNode.isVoiceProcessingBypassed), @"residualProcessing":@"aec3",
      @"automaticGain":@(engine.inputNode.isVoiceProcessingAGCEnabled),
      @"sampleRate":@(session.sampleRate), @"ioBufferSeconds":@(session.IOBufferDuration),
      @"input":session.currentRoute.inputs.firstObject.portType ?: @"",
      @"output":session.currentRoute.outputs.firstObject.portType ?: @""
    });
  }
  return started;
}
static void RBInstallInputTap(AVAudioNode *node, SEL selector, AVAudioNodeBus bus,
    AVAudioFrameCount size, AVAudioFormat *format, AVAudioNodeTapBlock block) {
  if (![node isKindOfClass:AVAudioInputNode.class] || !RBIsVoiceSession()) {
    RBOriginalTap(node, selector, bus, size, format, block); return;
  }
  RBVoiceAudioContext *context = RBContextForEngine(node.engine);
  __weak AVAudioEngine *engine = node.engine;
  RBOriginalTap(node, selector, bus, size, format, ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    RBVoiceEcho *echo = [context echoForFormat:buffer.format];
    // The system owns tap storage. Keep its audio intact; the original
    // resampler consumes our reusable processed copy synchronously.
    AVAudioPCMBuffer *processed = [context copyCapture:buffer];
    if (!echo || !processed || ![echo capture:processed atTime:when]) { RBFailVoiceAudio(engine, context); return; }
    block(processed, when);
  });
}
BOOL RBVoiceAudioAvailable(void) { return RBVoiceAudioInstalled; }
__attribute__((constructor)) static void RBInstallVoiceAudio(void) {
  Method start = class_getInstanceMethod(AVAudioEngine.class, @selector(startAndReturnError:));
  Method tap = class_getInstanceMethod(AVAudioNode.class, @selector(installTapOnBus:bufferSize:format:block:));
  if (!start || !tap) return;
  RBOriginalEngineStart = (void *)method_setImplementation(start, (IMP)RBStartVoiceEngine);
  RBOriginalTap = (void *)method_setImplementation(tap, (IMP)RBInstallInputTap);
  Class socketClass = NSClassFromString(@"SRWebSocket");
  Method open = class_getInstanceMethod(socketClass, @selector(open));
  if (open) RBOriginalSocketOpen = (void *)method_setImplementation(open, (IMP)RBOpenVoiceSocket);
  RBVoiceAudioInstalled = YES;
  [NSNotificationCenter.defaultCenter addObserverForName:AVAudioEngineConfigurationChangeNotification
    object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      AVAudioEngine *engine = notification.object;
      RBVoiceAudioContext *context = objc_getAssociatedObject(engine, RBEchoKey);
      // This notification also arrives after AVAudioEngine's native graph has
      // been disposed. Never query nodes or change taps from this deferred
      // callback. The next explicit start compares the live mixer identity.
      context.echo = nil;
    }];
  [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionRouteChangeNotification
    object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      AVAudioEngine *engine = RBCallEngine;
      // A new speaker/microphone route changes the acoustic path even if its
      // sample rate is unchanged. Rebuild the filter and timestamp ring.
      if (engine) RBContextForEngine(engine).echo = nil;
    }];
}

#endif
