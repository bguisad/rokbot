package dev.grokbot.nativeapp;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class VoiceManager {
    public static final int SAMPLE_RATE_HZ = 24000;
    public static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    public static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;

    public interface CallListener {
        void onStateChanged(String state);
        void onUserTranscript(String text);
        void onAssistantDelta(String delta);
        void onAssistantDone(String fullText);
        void onError(String message);
        void onClosed();
    }

    private final Context mContext;
    private AudioRecord mAudioRecord;
    private AudioTrack mAudioTrack;
    private AcousticEchoCanceler mAec;
    private NoiseSuppressor mNs;
    private WebSocketClient mSocket;
    private Thread mCaptureThread;
    private CallListener mListener;

    private volatile boolean mIsRecording = false;
    private volatile boolean mMuted = false;
    private volatile boolean mRunning = false;
    private volatile boolean mAecEnabled = false;
    private String mActiveItemId = null;

    public VoiceManager(Context context) {
        mContext = context.getApplicationContext();
    }

    public boolean isAecEnabled() {
        return mAecEnabled;
    }

    public boolean isRecording() {
        return mIsRecording;
    }

    public void setMuted(boolean muted) {
        mMuted = muted;
    }

    public boolean isMuted() {
        return mMuted;
    }

    public void setSpeakerphone(boolean enabled) {
        try {
            AudioManager am = (AudioManager) mContext.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setSpeakerphoneOn(enabled);
            }
        } catch (Throwable ignored) {}
    }

    public synchronized boolean initAudioCapture() {
        int bufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT);
        if (bufferSize <= 0) bufferSize = 4800;

        try {
            mAudioRecord = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                Math.max(bufferSize * 2, 9600)
            );
            if (mAudioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                mAudioRecord.release();
                mAudioRecord = null;
                return false;
            }

            if (AcousticEchoCanceler.isAvailable()) {
                mAec = AcousticEchoCanceler.create(mAudioRecord.getAudioSessionId());
                if (mAec != null) {
                    mAec.setEnabled(true);
                    mAecEnabled = mAec.getEnabled();
                }
            }

            if (NoiseSuppressor.isAvailable()) {
                mNs = NoiseSuppressor.create(mAudioRecord.getAudioSessionId());
                if (mNs != null) {
                    mNs.setEnabled(true);
                }
            }

            int playBuf = AudioTrack.getMinBufferSize(
                SAMPLE_RATE_HZ, AudioFormat.CHANNEL_OUT_MONO, AUDIO_FORMAT);
            if (playBuf <= 0) playBuf = 4800;
            mAudioTrack = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
                .setAudioFormat(new AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE_HZ)
                    .setEncoding(AUDIO_FORMAT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build())
                .setBufferSizeInBytes(Math.max(playBuf * 2, 9600))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    public void startCall(String agentId, CallListener listener) {
        mListener = listener;
        mRunning = true;
        new Thread(() -> {
            try {
                notifyState(Localize.t(mContext, "正在创建语音会话…", "Allocating voice session..."));
                boolean aecAvail = AcousticEchoCanceler.isAvailable();
                String mode = aecAvail ? "native-aec3-buffered-v1" : "legacy";
                JSONObject session = HostApiClient.createVoiceSession(mContext, agentId, mode);

                String secret = session.optString("clientSecret", "");
                String rawWsUrl = HostApiClient.extractVoiceWebsocketUrl(session);
                if (!HostApiClient.isValidVoiceCredential(mContext, session)) {
                    throw new IllegalStateException(Localize.t(mContext,
                            "语音会话凭证无效",
                            "Invalid voice session credentials"));
                }
                String wsUrl = HostApiClient.rewriteVoiceWebsocketUrl(mContext, rawWsUrl);
                String origin = HostApiClient.resolveVoiceOrigin(mContext, rawWsUrl);

                if (!initAudioCapture()) {
                    notifyState(Localize.t(mContext,
                            "麦克风硬件不可用，已切换文本轮次",
                            "Audio hardware unavailable; text-turn fallback active"));
                }

                notifyState(Localize.t(mContext, "正在连接实时语音…", "Connecting WebSocket..."));
                mSocket = new WebSocketClient(wsUrl, "xai-client-secret." + secret, origin, new WebSocketClient.Listener() {
                    @Override
                    public void onOpen(String negotiatedProtocol) {
                        notifyState(Localize.t(mContext, "已连接 (24kHz PCM)", "Connected (24kHz PCM)"));
                        sendSessionUpdate();
                        start();
                    }

                    @Override
                    public void onTextMessage(String text) {
                        handleServerFrame(text);
                    }

                    @Override
                    public void onClosed(int code, String reason) {
                        stop();
                        if (mListener != null) mListener.onClosed();
                    }

                    @Override
                    public void onError(Throwable error) {
                        if (mListener != null) mListener.onError(error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName());
                    }
                });
                mSocket.connect();
            } catch (Throwable t) {
                if (mListener != null) mListener.onError(t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName());
            }
        }, "grokbot-voice-init").start();
    }

    private void sendSessionUpdate() {
        try {
            JSONObject fmt = new JSONObject().put("type", "audio/pcm").put("rate", SAMPLE_RATE_HZ);
            JSONObject req = new JSONObject()
                .put("type", "session.update")
                .put("session", new JSONObject().put("audio", new JSONObject().put("input", new JSONObject().put("format", fmt))));
            if (mSocket != null) mSocket.sendText(req.toString());
        } catch (Throwable ignored) {}
    }

    public void commitAudioBuffer() {
        try {
            if (mSocket != null && mSocket.isOpen()) {
                mSocket.sendText(new JSONObject().put("type", "input_audio_buffer.commit").toString());
            }
        } catch (Throwable ignored) {}
    }

    public void cancelResponse() {
        flushPlayback();
        try {
            if (mSocket != null && mSocket.isOpen()) {
                mSocket.sendText(new JSONObject().put("type", "response.cancel").toString());
            }
        } catch (Throwable ignored) {}
    }

    public void sendPcmFrame(byte[] pcmBytes) {
        if (mSocket == null || !mSocket.isOpen() || pcmBytes == null || pcmBytes.length == 0) return;
        try {
            String b64 = Base64.encodeToString(pcmBytes, Base64.NO_WRAP);
            mSocket.sendText(new JSONObject()
                .put("type", "input_audio_buffer.append")
                .put("audio", b64)
                .toString());
        } catch (Throwable ignored) {}
    }

    public void hangUp() {
        mRunning = false;
        try {
            if (mSocket != null && mSocket.isOpen()) {
                mSocket.sendText(new JSONObject().put("type", "session.close").toString());
                mSocket.close(1000, "hung-up");
            }
        } catch (Throwable ignored) {}
        stop();
    }

    private void handleServerFrame(String raw) {
        try {
            JSONObject ev = new JSONObject(raw);
            String type = ev.optString("type", "");
            switch (type) {
                case "session.created":
                    notifyState(mAecEnabled ? "Listening (AEC Active)" : "Listening");
                    break;
                case "input_audio_buffer.speech_started":
                    flushPlayback();
                    notifyState("Listening (Speaking...)");
                    break;
                case "input_audio_buffer.speech_stopped":
                    notifyState("Transcribing...");
                    break;
                case "conversation.item.input_audio_transcription.completed": {
                    String tr = ev.optString("transcript", "");
                    if (!tr.isEmpty() && mListener != null) mListener.onUserTranscript(tr);
                    break;
                }
                case "response.created":
                    notifyState("Assistant responding...");
                    break;
                case "response.audio_transcript.delta": {
                    String delta = ev.optString("delta", "");
                    if (!delta.isEmpty() && mListener != null) mListener.onAssistantDelta(delta);
                    break;
                }
                case "response.audio.delta": {
                    mActiveItemId = ev.optString("item_id", mActiveItemId);
                    String deltaB64 = ev.optString("delta", "");
                    if (!deltaB64.isEmpty()) {
                        byte[] pcm = Base64.decode(deltaB64, Base64.DEFAULT);
                        playPcm(pcm);
                    }
                    break;
                }
                case "response.audio.done": {
                    String itemId = ev.optString("item_id", mActiveItemId);
                    if (itemId != null && !itemId.isEmpty() && mSocket != null && mSocket.isOpen()) {
                        mSocket.sendText(new JSONObject()
                            .put("type", "response.playback.done")
                            .put("item_id", itemId)
                            .toString());
                    }
                    break;
                }
                case "response.audio_transcript.done": {
                    String full = ev.optString("transcript", "");
                    if (mListener != null) mListener.onAssistantDone(full);
                    break;
                }
                case "response.done":
                case "response.cancelled":
                    if (mListener != null) mListener.onAssistantDone("");
                    notifyState(mAecEnabled ? "Listening (AEC Active)" : "Listening");
                    break;
                case "error": {
                    JSONObject err = ev.optJSONObject("error");
                    String msg = err != null ? err.optString("message", "Voice error") : "Voice error";
                    if (mListener != null) mListener.onError(msg);
                    break;
                }
            }
        } catch (Throwable ignored) {}
    }

    private void playPcm(byte[] pcm) {
        AudioTrack track = mAudioTrack;
        if (track == null || pcm == null || pcm.length == 0) return;
        try {
            if (track.getPlayState() != AudioTrack.PLAYSTATE_PLAYING) {
                track.play();
            }
            track.write(pcm, 0, pcm.length);
        } catch (Throwable ignored) {}
    }

    private void flushPlayback() {
        AudioTrack track = mAudioTrack;
        if (track != null) {
            try {
                track.pause();
                track.flush();
                track.play();
            } catch (Throwable ignored) {}
        }
    }

    public synchronized void start() {
        if (mAudioRecord != null && !mIsRecording) {
            mIsRecording = true;
            mAudioRecord.startRecording();
            if (mAudioTrack != null) {
                try { mAudioTrack.play(); } catch (Throwable ignored) {}
            }
            mCaptureThread = new Thread(() -> {
                byte[] frame = new byte[1920]; // 40ms @ 24kHz 16-bit mono
                while (mIsRecording && mRunning) {
                    AudioRecord rec = mAudioRecord;
                    if (rec == null) break;
                    int read = rec.read(frame, 0, frame.length);
                    if (read > 0 && !mMuted) {
                        byte[] chunk = (read == frame.length) ? frame : java.util.Arrays.copyOf(frame, read);
                        sendPcmFrame(chunk);
                    }
                }
            }, "grokbot-voice-capture");
            mCaptureThread.setDaemon(true);
            mCaptureThread.start();
        }
    }

    public synchronized void stop() {
        mIsRecording = false;
        mRunning = false;
        if (mCaptureThread != null) {
            mCaptureThread.interrupt();
            mCaptureThread = null;
        }
        if (mAudioRecord != null) {
            try {
                mAudioRecord.stop();
                mAudioRecord.release();
            } catch (Throwable ignored) {}
            mAudioRecord = null;
        }
        if (mAudioTrack != null) {
            try {
                mAudioTrack.stop();
                mAudioTrack.release();
            } catch (Throwable ignored) {}
            mAudioTrack = null;
        }
        if (mAec != null) {
            try { mAec.release(); } catch (Throwable ignored) {}
            mAec = null;
        }
        if (mNs != null) {
            try { mNs.release(); } catch (Throwable ignored) {}
            mNs = null;
        }
        try {
            AudioManager am = (AudioManager) mContext.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) am.setMode(AudioManager.MODE_NORMAL);
        } catch (Throwable ignored) {}
    }

    private void notifyState(String state) {
        if (mListener != null) mListener.onStateChanged(state);
    }

    // ---- One-shot WAV recorder for speech-to-text dictation (/local/audio/transcriptions) ----
    public static class DictationRecorder {
        private AudioRecord mRec;
        private volatile boolean mActive = false;
        private Thread mThread;
        private final ByteArrayOutputStream mPcm = new ByteArrayOutputStream();

        public boolean start() {
            int minBuf = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minBuf <= 0) minBuf = 3200;
            try {
                mRec = new AudioRecord(MediaRecorder.AudioSource.MIC, 16000,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 2);
                if (mRec.getState() != AudioRecord.STATE_INITIALIZED) {
                    mRec.release();
                    mRec = null;
                    return false;
                }
                mPcm.reset();
                mActive = true;
                mRec.startRecording();
                mThread = new Thread(() -> {
                    byte[] buf = new byte[1600];
                    while (mActive) {
                        int n = mRec.read(buf, 0, buf.length);
                        if (n > 0) {
                            synchronized (mPcm) { mPcm.write(buf, 0, n); }
                        }
                    }
                }, "grokbot-stt-rec");
                mThread.start();
                return true;
            } catch (Throwable t) {
                return false;
            }
        }

        public byte[] stopAndEncodeWav() {
            mActive = false;
            if (mThread != null) {
                try { mThread.join(500); } catch (InterruptedException ignored) {}
            }
            if (mRec != null) {
                try { mRec.stop(); mRec.release(); } catch (Throwable ignored) {}
                mRec = null;
            }
            byte[] pcmBytes;
            synchronized (mPcm) { pcmBytes = mPcm.toByteArray(); }
            return wrapPcmAsWav(pcmBytes, 16000, 1, 16);
        }

        public static byte[] wrapPcmAsWav(byte[] pcm, int sampleRate, int channels, int bitsPerSample) {
            ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            int byteRate = sampleRate * channels * (bitsPerSample / 8);
            header.put("RIFF".getBytes());
            header.putInt(36 + pcm.length);
            header.put("WAVE".getBytes());
            header.put("fmt ".getBytes());
            header.putInt(16);
            header.putShort((short) 1);
            header.putShort((short) channels);
            header.putInt(sampleRate);
            header.putInt(byteRate);
            header.putShort((short) (channels * (bitsPerSample / 8)));
            header.putShort((short) bitsPerSample);
            header.put("data".getBytes());
            header.putInt(pcm.length);
            byte[] wav = new byte[44 + pcm.length];
            System.arraycopy(header.array(), 0, wav, 0, 44);
            System.arraycopy(pcm, 0, wav, 44, pcm.length);
            return wav;
        }
    }
}
