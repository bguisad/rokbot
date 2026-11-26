// Pure Node.js Binary AndroidManifest (AXML) AST parser, patcher, and serializer.
// Zero native or SDK dependencies. Tested and verified with Android SDK aapt.

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
export const NONE = 0xffffffff;

// Common Android platform attribute resource IDs
export const KNOWN_RES_IDS = {
  theme: 0x01010000,
  label: 0x01010001,
  icon: 0x01010002,
  name: 0x01010003,
  exported: 0x01010010,
  authorities: 0x01010018,
  initOrder: 0x0101001a,
  grantUriPermissions: 0x0101001b,
  launchMode: 0x0101001d,
  configChanges: 0x0101001f,
  value: 0x01010024,
  resource: 0x01010025,
  mimeType: 0x01010026,
  scheme: 0x01010027,
  host: 0x01010028,
  drawable: 0x01010199,
  targetActivity: 0x01010202,
  minSdkVersion: 0x0101020c,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  windowSoftInputMode: 0x0101022b,
  targetSdkVersion: 0x01010270,
  allowBackup: 0x01010280,
  supportsRtl: 0x010103af,
  extractNativeLibs: 0x010104ea,
  fullBackupContent: 0x010104eb,
  usesCleartextTraffic: 0x010104ec,
  networkSecurityConfig: 0x01010527,
  roundIcon: 0x0101052c,
  compileSdkVersion: 0x01010572,
  compileSdkVersionCodename: 0x01010573,
  appComponentFactory: 0x0101057a,
  foregroundServiceType: 0x01010599,
  dataExtractionRules: 0x0101063e,
  requiredSplitTypes: 0x0101064e,
  splitTypes: 0x0101064f,
  enableOnBackInvokedCallback: 0x0101066c,
};

// Reverse map for lookup
const RES_ID_TO_NAME = Object.fromEntries(
  Object.entries(KNOWN_RES_IDS).map(([name, id]) => [id, name])
);

export function parseAxml(buffer) {
  if (buffer.length < 8) throw new Error('AXML buffer too short');
  const docType = buffer.readUInt16LE(0);
  const docHeaderSize = buffer.readUInt16LE(2);
  const docSize = buffer.readUInt32LE(4);
  if (docType !== RES_XML_TYPE || docSize !== buffer.length) {
    throw new Error('Not a valid AXML binary document');
  }

  let at = docHeaderSize;
  let strings = [];
  let isUtf8 = false;
  let resMap = []; // array of res IDs
  const namespaces = []; // { prefix, uri, lineNumber }
  const rootNodes = [];
  const elementStack = [];

  while (at < buffer.length) {
    if (at + 8 > buffer.length) {
      throw new Error(`Truncated AXML chunk header at offset ${at}`);
    }
    const chunkType = buffer.readUInt16LE(at);
    const chunkHeaderSize = buffer.readUInt16LE(at + 2);
    const chunkSize = buffer.readUInt32LE(at + 4);
    if (chunkSize < 8 || at + chunkSize > buffer.length) {
      throw new Error(`Invalid AXML chunk size: ${chunkSize} at offset ${at}`);
    }
    const chunkBytes = buffer.subarray(at, at + chunkSize);

    if (chunkType === RES_STRING_POOL_TYPE) {
      const stringCount = chunkBytes.readUInt32LE(8);
      const styleCount = chunkBytes.readUInt32LE(12);
      const flags = chunkBytes.readUInt32LE(16);
      isUtf8 = (flags & 0x0100) !== 0;
      const stringsStart = chunkBytes.readUInt32LE(20);
      const offsets = [];
      for (let i = 0; i < stringCount; i++) {
        offsets.push(chunkBytes.readUInt32LE(chunkHeaderSize + i * 4));
      }

      strings = offsets.map(offset => {
        let pos = stringsStart + offset;
        if (isUtf8) {
          let charLen = chunkBytes[pos++];
          if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | chunkBytes[pos++];
          let byteLen = chunkBytes[pos++];
          if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | chunkBytes[pos++];
          return chunkBytes.toString('utf8', pos, pos + byteLen);
        } else {
          let charLen = chunkBytes.readUInt16LE(pos);
          pos += 2;
          return chunkBytes.toString('utf16le', pos, pos + charLen * 2);
        }
      });
    } else if (chunkType === RES_XML_RESOURCE_MAP_TYPE) {
      const count = (chunkSize - chunkHeaderSize) / 4;
      for (let i = 0; i < count; i++) {
        resMap.push(chunkBytes.readUInt32LE(chunkHeaderSize + i * 4));
      }
    } else if (chunkType === RES_XML_START_NAMESPACE_TYPE) {
      const lineNumber = chunkBytes.readUInt32LE(8);
      const prefixIdx = chunkBytes.readUInt32LE(16);
      const uriIdx = chunkBytes.readUInt32LE(20);
      namespaces.push({
        prefix: strings[prefixIdx] ?? '',
        uri: strings[uriIdx] ?? '',
        lineNumber,
      });
    } else if (chunkType === RES_XML_START_ELEMENT_TYPE) {
      const lineNumber = chunkBytes.readUInt32LE(8);
      const commentIdx = chunkBytes.readUInt32LE(12);
      const nsIdx = chunkBytes.readUInt32LE(16);
      const nameIdx = chunkBytes.readUInt32LE(20);
      const attrStart = chunkBytes.readUInt16LE(24);
      const attrSize = chunkBytes.readUInt16LE(26);
      const attrCount = chunkBytes.readUInt16LE(28);

      const name = strings[nameIdx];
      const namespace = nsIdx !== NONE ? strings[nsIdx] : null;
      const attributes = [];

      for (let i = 0; i < attrCount; i++) {
        const aOffset = chunkHeaderSize + attrStart + i * attrSize;
        const aNsIdx = chunkBytes.readUInt32LE(aOffset);
        const aNameIdx = chunkBytes.readUInt32LE(aOffset + 4);
        const aRawIdx = chunkBytes.readUInt32LE(aOffset + 8);
        const aType = chunkBytes[aOffset + 15]; // type byte in 16-byte TypedValue (size:2, res0:1, type:1, data:4)
        const aData = chunkBytes.readUInt32LE(aOffset + 16);

        const aNs = aNsIdx !== NONE ? strings[aNsIdx] : null;
        const aName = strings[aNameIdx];
        const aRaw = aRawIdx !== NONE ? strings[aRawIdx] : null;

        let resId = null;
        if (aNameIdx < resMap.length) {
          resId = resMap[aNameIdx];
        } else if (aNs === ANDROID_NS && KNOWN_RES_IDS[aName]) {
          resId = KNOWN_RES_IDS[aName];
        }

        let typedValue;
        if (aType === 0x03) {
          // TYPE_STRING
          typedValue = strings[aData] ?? aRaw ?? '';
        } else if (aType === 0x12) {
          // TYPE_INT_BOOLEAN
          typedValue = aData !== 0;
        } else {
          typedValue = aData;
        }

        attributes.push({
          name: aName,
          namespace: aNs,
          resourceId: resId,
          type: aType,
          rawValue: aRaw,
          value: typedValue,
          data: aData,
        });
      }

      const node = {
        type: 'element',
        name,
        namespace,
        lineNumber,
        attributes,
        children: [],
      };

      if (elementStack.length > 0) {
        elementStack[elementStack.length - 1].children.push(node);
      } else {
        rootNodes.push(node);
      }
      elementStack.push(node);
    } else if (chunkType === RES_XML_END_ELEMENT_TYPE) {
      if (elementStack.length > 0) {
        elementStack.pop();
      }
    }

    at += chunkSize;
  }

  return { rootNodes, namespaces, strings, resMap, isUtf8 };
}

export function sortAttributesByResourceId(attributes) {
  return attributes
    .map((attr, index) => ({ attr, index, resId: attr.resourceId ? attr.resourceId >>> 0 : 0 }))
    .sort((a, b) => {
      if (a.resId && b.resId) return a.resId - b.resId || a.index - b.index;
      if (a.resId) return -1;
      if (b.resId) return 1;
      return a.index - b.index;
    })
    .map(item => item.attr);
}

export function serializeAxml(ast) {
  const { rootNodes, namespaces = [] } = ast;

  // 1. Collect all attributes with resource IDs and determine string ordering
  // Android requires resource IDs to align 1:1 with string indices 0..resCount-1.
  const resAttrOrder = [];
  const resIdList = [];
  const otherStrings = [];
  const stringToIndex = new Map();

  function registerString(str) {
    if (typeof str !== 'string') return NONE;
    if (stringToIndex.has(str)) return stringToIndex.get(str);
    const idx = resAttrOrder.length + otherStrings.length;
    otherStrings.push(str);
    stringToIndex.set(str, idx);
    return idx;
  }

  // Pre-collect all attributes from entire tree
  function scanAttributes(node) {
    if (node.attributes) {
      for (const attr of node.attributes) {
        let resId = attr.resourceId;
        if (!resId && attr.namespace === ANDROID_NS && KNOWN_RES_IDS[attr.name]) {
          resId = KNOWN_RES_IDS[attr.name];
          attr.resourceId = resId;
        }
        if (resId && !stringToIndex.has(attr.name)) {
          const idx = resAttrOrder.length;
          resAttrOrder.push(attr.name);
          resIdList.push(resId);
          stringToIndex.set(attr.name, idx);
        }
      }
    }
    if (node.children) {
      for (const child of node.children) scanAttributes(child);
    }
  }

  for (const root of rootNodes) scanAttributes(root);

  // Register namespaces
  const nsList = namespaces.length > 0 ? namespaces : [
    { prefix: 'android', uri: ANDROID_NS, lineNumber: 2 }
  ];
  for (const ns of nsList) {
    registerString(ns.prefix);
    registerString(ns.uri);
  }

  // Register element names and attributes
  function collectAllStrings(node) {
    registerString(node.name);
    if (node.namespace) registerString(node.namespace);
    for (const attr of node.attributes || []) {
      registerString(attr.name);
      if (attr.namespace) registerString(attr.namespace);
      if (attr.rawValue != null) registerString(attr.rawValue);
      if (attr.type === 0x03 && typeof attr.value === 'string') {
        registerString(attr.value);
      }
    }
    for (const child of node.children || []) collectAllStrings(child);
  }
  for (const root of rootNodes) collectAllStrings(root);

  const allStrings = [...resAttrOrder, ...otherStrings];
  // Re-map indices
  stringToIndex.clear();
  allStrings.forEach((s, idx) => stringToIndex.set(s, idx));

  // 2. Build String Pool Chunk (using UTF-16LE for maximum Android backward compatibility)
  const stringPoolParts = [];
  const stringOffsets = [];
  let currentStringOffset = 0;

  for (const s of allStrings) {
    stringOffsets.push(currentStringOffset);
    const utf16Buf = Buffer.from(s, 'utf16le');
    const lenHeader = Buffer.alloc(2);
    lenHeader.writeUInt16LE(s.length, 0);
    const nullTerminator = Buffer.alloc(2); // 0x0000
    const strChunk = Buffer.concat([lenHeader, utf16Buf, nullTerminator]);
    stringPoolParts.push(strChunk);
    currentStringOffset += strChunk.length;
  }

  let stringData = Buffer.concat(stringPoolParts);
  const paddingLen = (4 - (stringData.length % 4)) % 4;
  if (paddingLen > 0) {
    stringData = Buffer.concat([stringData, Buffer.alloc(paddingLen)]);
  }

  const headerSize = 28;
  const offsetsSize = allStrings.length * 4;
  const stringsStart = headerSize + offsetsSize;
  const poolSize = stringsStart + stringData.length;

  const poolHeader = Buffer.alloc(headerSize);
  poolHeader.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  poolHeader.writeUInt16LE(headerSize, 2);
  poolHeader.writeUInt32LE(poolSize, 4);
  poolHeader.writeUInt32LE(allStrings.length, 8); // stringCount
  poolHeader.writeUInt32LE(0, 12); // styleCount
  poolHeader.writeUInt32LE(0, 16); // flags (UTF-16)
  poolHeader.writeUInt32LE(stringsStart, 20);
  poolHeader.writeUInt32LE(0, 24); // stylesStart

  const offsetsBuf = Buffer.alloc(offsetsSize);
  stringOffsets.forEach((off, i) => offsetsBuf.writeUInt32LE(off, i * 4));

  const stringPoolChunk = Buffer.concat([poolHeader, offsetsBuf, stringData]);

  // 3. Build Resource Map Chunk (0x0180)
  const resMapHeaderSize = 8;
  const resMapSize = resMapHeaderSize + resIdList.length * 4;
  const resMapChunk = Buffer.alloc(resMapSize);
  resMapChunk.writeUInt16LE(RES_XML_RESOURCE_MAP_TYPE, 0);
  resMapChunk.writeUInt16LE(resMapHeaderSize, 2);
  resMapChunk.writeUInt32LE(resMapSize, 4);
  resIdList.forEach((id, i) => resMapChunk.writeUInt32LE(id, resMapHeaderSize + i * 4));

  // 4. Build XML Tree Chunks
  const xmlBodyParts = [];

  // Start namespaces
  for (const ns of nsList) {
    const nsChunk = Buffer.alloc(24);
    nsChunk.writeUInt16LE(RES_XML_START_NAMESPACE_TYPE, 0);
    nsChunk.writeUInt16LE(16, 2);
    nsChunk.writeUInt32LE(24, 4);
    nsChunk.writeUInt32LE(ns.lineNumber || 2, 8);
    nsChunk.writeUInt32LE(NONE, 12);
    nsChunk.writeUInt32LE(stringToIndex.get(ns.prefix), 16);
    nsChunk.writeUInt32LE(stringToIndex.get(ns.uri), 20);
    xmlBodyParts.push(nsChunk);
  }

  function serializeNode(node) {
    // Android's attribute lookup (AssetManager RetrieveAttributes / XmlAttributeFinder) walks element
    // attributes assuming ascending resource IDs, exactly as aapt2 emits them. Attributes appended out
    // of order (e.g. an injected android:usesCleartextTraffic after android:enableOnBackInvokedCallback)
    // are silently ignored by PackageParser, so keep resource-ID attributes sorted and put the
    // non-resource attributes after them in their original order.
    const attrs = sortAttributesByResourceId(node.attributes || []);
    const attrSize = 20;
    const elemHeaderSize = 16;
    const elemExtraSize = 20;
    const elemChunkSize = elemHeaderSize + elemExtraSize + attrs.length * attrSize;

    const startElem = Buffer.alloc(elemChunkSize);
    startElem.writeUInt16LE(RES_XML_START_ELEMENT_TYPE, 0);
    startElem.writeUInt16LE(elemHeaderSize, 2);
    startElem.writeUInt32LE(elemChunkSize, 4);
    startElem.writeUInt32LE(node.lineNumber || 2, 8);
    startElem.writeUInt32LE(NONE, 12); // comment
    startElem.writeUInt32LE(node.namespace ? stringToIndex.get(node.namespace) : NONE, 16);
    startElem.writeUInt32LE(stringToIndex.get(node.name), 20);
    startElem.writeUInt16LE(elemExtraSize, 24); // attributeStart
    startElem.writeUInt16LE(attrSize, 26); // attributeSize
    startElem.writeUInt16LE(attrs.length, 28); // attributeCount
    startElem.writeUInt16LE(0, 30); // idIndex
    startElem.writeUInt16LE(0, 32); // classIndex
    startElem.writeUInt16LE(0, 34); // styleIndex

    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      const offset = elemHeaderSize + elemExtraSize + i * attrSize;
      const aNsIdx = attr.namespace ? stringToIndex.get(attr.namespace) : NONE;
      const aNameIdx = stringToIndex.get(attr.name);
      let aRawIdx = attr.rawValue != null ? stringToIndex.get(String(attr.rawValue)) : NONE;

      startElem.writeUInt32LE(aNsIdx, offset);
      startElem.writeUInt32LE(aNameIdx, offset + 4);
      startElem.writeUInt32LE(aRawIdx, offset + 8);
      startElem.writeUInt16LE(8, offset + 12); // size = 8
      startElem.writeUInt8(0, offset + 14); // res0 = 0
      startElem.writeUInt8(attr.type, offset + 15); // dataType

      let dataVal = 0;
      if (attr.type === 0x03) {
        // String
        dataVal = stringToIndex.get(String(attr.value));
      } else if (attr.type === 0x12) {
        // Boolean
        dataVal = attr.value ? 0xffffffff : 0x00000000;
      } else if (typeof attr.value === 'number') {
        dataVal = attr.value;
      } else if (attr.data != null) {
        dataVal = attr.data;
      }
      startElem.writeUInt32LE(dataVal >>> 0, offset + 16);
    }

    xmlBodyParts.push(startElem);

    // Recursively serialize children
    for (const child of node.children || []) {
      serializeNode(child);
    }

    // End element
    const endElem = Buffer.alloc(24);
    endElem.writeUInt16LE(RES_XML_END_ELEMENT_TYPE, 0);
    endElem.writeUInt16LE(elemHeaderSize, 2);
    endElem.writeUInt32LE(24, 4);
    endElem.writeUInt32LE(node.lineNumber || 2, 8);
    endElem.writeUInt32LE(NONE, 12);
    endElem.writeUInt32LE(node.namespace ? stringToIndex.get(node.namespace) : NONE, 16);
    endElem.writeUInt32LE(stringToIndex.get(node.name), 20);
    xmlBodyParts.push(endElem);
  }

  for (const root of rootNodes) serializeNode(root);

  // End namespaces
  for (const ns of [...nsList].reverse()) {
    const endNs = Buffer.alloc(24);
    endNs.writeUInt16LE(RES_XML_END_NAMESPACE_TYPE, 0);
    endNs.writeUInt16LE(16, 2);
    endNs.writeUInt32LE(24, 4);
    endNs.writeUInt32LE(ns.lineNumber || 2, 8);
    endNs.writeUInt32LE(NONE, 12);
    endNs.writeUInt32LE(stringToIndex.get(ns.prefix), 16);
    endNs.writeUInt32LE(stringToIndex.get(ns.uri), 20);
    xmlBodyParts.push(endNs);
  }

  const allChunks = [stringPoolChunk, resMapChunk, ...xmlBodyParts];
  const totalBodyLength = allChunks.reduce((acc, c) => acc + c.length, 0);
  const totalDocSize = 8 + totalBodyLength;

  const docHeader = Buffer.alloc(8);
  docHeader.writeUInt16LE(RES_XML_TYPE, 0);
  docHeader.writeUInt16LE(8, 2);
  docHeader.writeUInt32LE(totalDocSize, 4);

  return Buffer.concat([docHeader, ...allChunks]);
}

export function extractManifestInfo(axmlBuffer) {
  const ast = parseAxml(axmlBuffer);
  const root = ast.rootNodes.find(n => n.name === 'manifest');
  if (!root) return { packageName: null, versionCode: null, versionName: null };
  const pkgAttr = (root.attributes || []).find(a => a.name === 'package' && !a.namespace);
  const vcAttr = (root.attributes || []).find(a => a.name === 'versionCode' || a.resourceId === KNOWN_RES_IDS.versionCode);
  const vnAttr = (root.attributes || []).find(a => a.name === 'versionName' || a.resourceId === KNOWN_RES_IDS.versionName);
  return {
    packageName: pkgAttr ? String(pkgAttr.value) : null,
    versionCode: vcAttr ? vcAttr.value : null,
    versionName: vnAttr ? String(vnAttr.value) : null,
  };
}

/**
 * RokBot versioning on top of the pinned upstream build: versionCode = upstream * 100 + build
 * (3212 -> 321201, 321202, ...; a future upstream 3213 continues at 321301, still higher), and
 * versionName = "<upstream>-rokbot.<build>". Explicit versionCode/versionName override either part.
 */
export function resolveRokbotVersion(upstream = {}, options = {}) {
  const upstreamCode = Number(upstream.versionCode);
  const upstreamName = String(upstream.versionName ?? '').trim();
  const build = options.rokbotBuild != null && options.rokbotBuild !== '' ? Number(options.rokbotBuild) : null;
  if (build != null && !(Number.isInteger(build) && build >= 1 && build <= 99)) {
    throw new Error(`--rokbot-build must be an integer between 1 and 99, got ${options.rokbotBuild}`);
  }
  let versionCode = options.versionCode != null && options.versionCode !== '' ? Number(options.versionCode) : null;
  let versionName = options.versionName != null && String(options.versionName).trim() ? String(options.versionName).trim() : null;
  if (build != null) {
    if (!(Number.isInteger(upstreamCode) && upstreamCode > 0)) throw new Error('Upstream versionCode is unknown; pass --version-code');
    if (versionCode == null) versionCode = upstreamCode * 100 + build;
    if (versionName == null) versionName = `${upstreamName || '0'}-rokbot.${build}`;
  }
  if (versionCode != null) {
    if (!(Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode <= 2100000000)) {
      throw new Error(`versionCode must be a positive integer <= 2100000000, got ${options.versionCode ?? versionCode}`);
    }
    if (Number.isInteger(upstreamCode) && upstreamCode > 0 && versionCode < upstreamCode) {
      throw new Error(`versionCode ${versionCode} is lower than the upstream ${upstreamCode}; Android would refuse the upgrade`);
    }
  }
  if (versionName != null && (versionName.length > 64 || /[\u0000-\u001f\u007f]/.test(versionName))) {
    throw new Error('versionName must be at most 64 printable characters');
  }
  return { versionCode, versionName };
}

function applyVersionOverride(root, options) {
  root.attributes = root.attributes || [];
  if (options.versionCode != null) {
    const code = Number(options.versionCode);
    let a = root.attributes.find(x => x.name === 'versionCode' || x.resourceId === KNOWN_RES_IDS.versionCode);
    if (!a) {
      a = { name: 'versionCode', namespace: ANDROID_NS, resourceId: KNOWN_RES_IDS.versionCode };
      root.attributes.push(a);
    }
    a.type = 0x10;
    a.rawValue = null;
    a.value = code;
    a.data = code >>> 0;
  }
  if (options.versionName != null) {
    const name = String(options.versionName);
    let a = root.attributes.find(x => x.name === 'versionName' || x.resourceId === KNOWN_RES_IDS.versionName);
    if (!a) {
      a = { name: 'versionName', namespace: ANDROID_NS, resourceId: KNOWN_RES_IDS.versionName };
      root.attributes.push(a);
    }
    a.type = 0x03;
    a.rawValue = name;
    a.value = name;
  }
}

/**
 * Patch AndroidManifest.xml:
 * - Ensure android:usesCleartextTraffic="true"
 * - Disable Expo OTA updates metadata if present
 * - Inject RokBotInitProvider (initializes native companion before Application.onCreate)
 * - Inject native companion Activities (Pairing, BotList + deep links, Chat, Library, VoiceCall, PushSettings, Profile, Usage, Computers)
 * - Inject NotificationService (dataSync), VoiceCallService (microphone), BootReceiver, UnifiedPushReceiver
 * - Inject required permissions
 */
export function patchManifest(axmlBuffer, options = {}) {
  const ast = parseAxml(axmlBuffer);
  const root = ast.rootNodes.find(n => n.name === 'manifest');
  if (!root) throw new Error('AndroidManifest.xml root <manifest> not found');

  const appNode = root.children.find(n => n.name === 'application');
  if (!appNode) throw new Error('<application> element not found in manifest');

  const pkgAttr = (root.attributes || []).find(a => a.name === 'package' && !a.namespace);
  const origPkg = pkgAttr && pkgAttr.value ? String(pkgAttr.value) : null;
  const packageName = options.packageName || origPkg || 'ai.x.grok.bot';

  const expandRelativeClassName = (val, basePkg) => {
    const s = String(val || '');
    if (!s || !basePkg) return s;
    if (s.startsWith('.')) return `${basePkg}${s}`;
    if (!s.includes('.')) return `${basePkg}.${s}`;
    return s;
  };

  if (options.packageName && origPkg && options.packageName !== origPkg) {
    const rewriteNameAttr = (node, resId, attrName, fn) => {
      const a = (node.attributes || []).find(
        x => x.resourceId === resId || (x.name === attrName && x.namespace === ANDROID_NS)
      );
      if (a && a.value != null) {
        const next = fn(String(a.value));
        a.rawValue = next;
        a.value = next;
        if (!a.resourceId && resId) a.resourceId = resId;
      }
    };
    rewriteNameAttr(appNode, KNOWN_RES_IDS.name, 'name', v => expandRelativeClassName(v, origPkg));
    for (const child of appNode.children || []) {
      if (['activity', 'activity-alias', 'service', 'receiver', 'provider'].includes(child.name)) {
        rewriteNameAttr(child, KNOWN_RES_IDS.name, 'name', v => expandRelativeClassName(v, origPkg));
        if (child.name === 'activity-alias') {
          rewriteNameAttr(child, KNOWN_RES_IDS.targetActivity, 'targetActivity', v => expandRelativeClassName(v, origPkg));
        }
        if (child.name === 'provider') {
          rewriteNameAttr(child, KNOWN_RES_IDS.authorities, 'authorities', authStr =>
            authStr.split(';').map(part => {
              if (part === origPkg) return packageName;
              if (part.startsWith(origPkg + '.')) return packageName + part.slice(origPkg.length);
              return part;
            }).join(';')
          );
        }
      }
    }
    for (const rootChild of root.children || []) {
      if (rootChild.name === 'permission' || rootChild.name === 'uses-permission') {
        rewriteNameAttr(rootChild, KNOWN_RES_IDS.name, 'name', v =>
          v.startsWith(origPkg + '.') ? packageName + v.slice(origPkg.length) : v
        );
      }
    }
    if (pkgAttr) {
      pkgAttr.rawValue = packageName;
      pkgAttr.value = packageName;
    } else {
      root.attributes.push({
        name: 'package',
        namespace: null,
        type: 0x03,
        rawValue: packageName,
        value: packageName,
      });
    }
  }

  // RokBot's own release numbering (see resolveRokbotVersion): Android only upgrades in place when
  // the new versionCode is >= the installed one, so every RokBot build carries its own code.
  if (options.versionCode != null || options.versionName != null) {
    applyVersionOverride(root, options);
  }

  if (options.repackageOnly) {
    return serializeAxml(ast);
  }

  const makeAttrStr = (name, value) => ({
    name,
    namespace: ANDROID_NS,
    resourceId: KNOWN_RES_IDS[name],
    type: 0x03,
    rawValue: String(value),
    value: String(value),
  });

  const makeAttrBool = (name, value) => ({
    name,
    namespace: ANDROID_NS,
    resourceId: KNOWN_RES_IDS[name],
    type: 0x12,
    rawValue: value ? 'true' : 'false',
    value: Boolean(value),
    data: value ? 0xffffffff : 0x00000000,
  });

  const makeAttrInt = (name, value) => ({
    name,
    namespace: ANDROID_NS,
    resourceId: KNOWN_RES_IDS[name],
    type: 0x10,
    rawValue: String(value | 0),
    value: value | 0,
    data: (value | 0) >>> 0,
  });

  const makeAttrHex = (name, value) => ({
    name,
    namespace: ANDROID_NS,
    resourceId: KNOWN_RES_IDS[name],
    type: 0x11,
    rawValue: '0x' + (value >>> 0).toString(16).padStart(8, '0'),
    value: value >>> 0,
    data: value >>> 0,
  });

  const makeEl = (name, attributes = [], children = [], lineNumber = 10) => ({
    type: 'element',
    name,
    namespace: null,
    lineNumber,
    attributes,
    children,
  });

  const getAndroidNameAttr = node =>
    (node.attributes || []).find(
      a => (a.resourceId === KNOWN_RES_IDS.name || (a.name === 'name' && a.namespace === ANDROID_NS))
    );

  const upsertAppChild = (tag, className, attributes, children = []) => {
    const existing = (appNode.children || []).find(c => {
      if (c.name !== tag) return false;
      const na = getAndroidNameAttr(c);
      return na && (na.value === className || (className.startsWith(packageName + '.') && na.value === className.slice(packageName.length)));
    });
    if (!existing) {
      appNode.children.push(makeEl(tag, attributes, children));
    }
    return existing;
  };

  // Clean up existing duplicate attributes on <application>
  const seenAttrKeys = new Set();
  appNode.attributes = (appNode.attributes || []).filter(attr => {
    const key = attr.resourceId
      ? `res:${attr.resourceId}`
      : `${attr.namespace || ''}:${attr.name}`;
    if (seenAttrKeys.has(key)) return false;
    seenAttrKeys.add(key);
    return true;
  });

  // 1. Injected Application attributes: usesCleartextTraffic="true"
  let cleartextAttr = appNode.attributes.find(
    a => (a.resourceId === KNOWN_RES_IDS.usesCleartextTraffic) ||
         (a.name === 'usesCleartextTraffic' && a.namespace === ANDROID_NS)
  );
  if (!cleartextAttr) {
    appNode.attributes.push(makeAttrBool('usesCleartextTraffic', true));
  } else {
    cleartextAttr.type = 0x12;
    cleartextAttr.rawValue = 'true';
    cleartextAttr.value = true;
    cleartextAttr.data = 0xffffffff;
    cleartextAttr.resourceId = KNOWN_RES_IDS.usesCleartextTraffic;
  }

  // Strip android:networkSecurityConfig so bundled restrictive XML configs cannot override usesCleartextTraffic
  appNode.attributes = (appNode.attributes || []).filter(
    a => !(a.resourceId === KNOWN_RES_IDS.networkSecurityConfig ||
           (a.name === 'networkSecurityConfig' && a.namespace === ANDROID_NS))
  );

  // Strip Play split requirement markers and Pairip license/anti-tamper manifest entries
  const isSplitAttr = a =>
    a.resourceId === KNOWN_RES_IDS.requiredSplitTypes ||
    a.resourceId === KNOWN_RES_IDS.splitTypes ||
    (a.namespace === ANDROID_NS && (a.name === 'requiredSplitTypes' || a.name === 'splitTypes'));
  if (root.attributes) root.attributes = root.attributes.filter(a => !isSplitAttr(a));
  if (appNode.attributes) appNode.attributes = appNode.attributes.filter(a => !isSplitAttr(a));

  const getAndroidName = node => {
    const a = (node.attributes || []).find(
      x => x.resourceId === KNOWN_RES_IDS.name || (x.name === 'name' && x.namespace === ANDROID_NS)
    );
    return a && a.value != null ? String(a.value) : '';
  };

  root.children = (root.children || []).filter(c => {
    if (c.name === 'uses-permission' && getAndroidName(c) === 'com.android.vending.CHECK_LICENSE') {
      return false;
    }
    return true;
  });

  const PAIRIP_COMPONENTS = new Set([
    'com.pairip.licensecheck.LicenseActivity',
    'com.pairip.licensecheck.LicenseContentProvider',
    'com.pairip.InitContextProvider',
  ]);
  const SPLIT_META_NAMES = new Set([
    'com.android.vending.splits',
    'com.android.vending.splits.required',
    'com.android.vending.derived.apk.id',
  ]);
  appNode.children = (appNode.children || []).filter(c => {
    const cname = getAndroidName(c);
    if ((c.name === 'activity' || c.name === 'provider') && PAIRIP_COMPONENTS.has(cname)) {
      return false;
    }
    if (c.name === 'meta-data' && SPLIT_META_NAMES.has(cname)) {
      return false;
    }
    return true;
  });

  if (options.setApplicationName && options.appComponentFactory !== false) {
    const acfName = options.appComponentFactory || 'dev.rokbot.nativeapp.RokBotAppComponentFactory';
    let acfAttr = (appNode.attributes || []).find(
      a =>
        a.resourceId === KNOWN_RES_IDS.appComponentFactory ||
        (a.name === 'appComponentFactory' && a.namespace === ANDROID_NS)
    );
    if (acfAttr) {
      acfAttr.rawValue = acfName;
      acfAttr.value = acfName;
      acfAttr.resourceId = KNOWN_RES_IDS.appComponentFactory;
    } else {
      appNode.attributes.push(makeAttrStr('appComponentFactory', acfName));
    }
  }

  // 2. Set application android:name only if explicitly requested
  const customAppName = options.applicationName || 'dev.rokbot.nativeapp.RokBotApplication';
  if (options.setApplicationName) {
    let appNameAttr = appNode.attributes.find(
      a => (a.resourceId === KNOWN_RES_IDS.name) ||
           (a.name === 'name' && a.namespace === ANDROID_NS)
    );
    if (!appNameAttr) {
      appNode.attributes.push(makeAttrStr('name', customAppName));
    } else {
      appNameAttr.type = 0x03;
      appNameAttr.rawValue = customAppName;
      appNameAttr.value = customAppName;
      appNameAttr.resourceId = KNOWN_RES_IDS.name;
    }
  }

  // 2a. Set application android:label to RokBot (unless explicitly disabled)
  if (options.appLabel !== false) {
    const appLabel = typeof options.appLabel === 'string' && options.appLabel.trim()
      ? options.appLabel.trim()
      : 'RokBot';
    let labelAttr = appNode.attributes.find(
      a => (a.resourceId === KNOWN_RES_IDS.label) ||
           (a.name === 'label' && a.namespace === ANDROID_NS)
    );
    if (!labelAttr) {
      appNode.attributes.push(makeAttrStr('label', appLabel));
    } else {
      labelAttr.type = 0x03;
      labelAttr.rawValue = appLabel;
      labelAttr.value = appLabel;
      labelAttr.resourceId = KNOWN_RES_IDS.label;
      delete labelAttr.data;
    }
  }

  // 2b. Disable Expo Updates metadata if present in host APK manifest
  for (const child of appNode.children || []) {
    if (child.name !== 'meta-data') continue;
    const nameAttr = getAndroidNameAttr(child);
    if (!nameAttr) continue;
    const metaKey = String(nameAttr.value || '');
    const valAttr = (child.attributes || []).find(
      a => a.resourceId === KNOWN_RES_IDS.value || (a.name === 'value' && a.namespace === ANDROID_NS)
    );
    if (metaKey === 'expo.modules.updates.ENABLED') {
      if (valAttr) {
        valAttr.type = 0x12;
        valAttr.rawValue = 'false';
        valAttr.value = false;
        valAttr.data = 0x00000000;
        valAttr.resourceId = KNOWN_RES_IDS.value;
      } else {
        child.attributes.push(makeAttrBool('value', false));
      }
    } else if (metaKey === 'expo.modules.updates.EXPO_UPDATES_CHECK_ON_LAUNCH') {
      if (valAttr) {
        valAttr.type = 0x03;
        valAttr.rawValue = 'NEVER';
        valAttr.value = 'NEVER';
        valAttr.resourceId = KNOWN_RES_IDS.value;
      } else {
        child.attributes.push(makeAttrStr('value', 'NEVER'));
      }
    }
  }

  // 3. Inject RokBotInitProvider (runs RokBotBootstrap.init before Application.onCreate)
  const providerName = 'dev.rokbot.nativeapp.RokBotInitProvider';
  upsertAppChild('provider', providerName, [
    makeAttrStr('name', providerName),
    makeAttrStr('authorities', `${packageName}.rokbot.init`),
    makeAttrBool('exported', false),
    makeAttrInt('initOrder', 999999),
  ]);

  // 3b. Inject ApkUpdateProvider (serves staged incremental APK updates to PackageInstaller)
  const updateProviderName = 'dev.rokbot.nativeapp.ApkUpdateProvider';
  upsertAppChild('provider', updateProviderName, [
    makeAttrStr('name', updateProviderName),
    makeAttrStr('authorities', `${packageName}.rokbot.updateprovider`),
    makeAttrBool('exported', false),
    makeAttrBool('grantUriPermissions', true),
  ]);

  // 4. Inject native companion Activities
  const pairingActivityName = options.pairingActivity || 'dev.rokbot.nativeapp.PairingActivity';
  upsertAppChild('activity', pairingActivityName, [
    makeAttrStr('name', pairingActivityName),
    makeAttrBool('exported', true),
    makeAttrHex('windowSoftInputMode', 0x00000010),
  ]);

  // Attach rokbot-local://agent deep-link filter directly onto the existing LAUNCHER activity (official RN MainActivity)
  const hasFilterAction = (el, actionVal) => (el.children || []).some(
    f => f.name === 'intent-filter' && (f.children || []).some(
      c => c.name === 'action' && getAndroidNameAttr(c)?.value === actionVal
    )
  );
  const hasFilterCategory = (el, catVal) => (el.children || []).some(
    f => f.name === 'intent-filter' && (f.children || []).some(
      c => c.name === 'category' && getAndroidNameAttr(c)?.value === catVal
    )
  );
  let launcherAct = (appNode.children || []).find(
    c => c.name === 'activity' && hasFilterAction(c, 'android.intent.action.MAIN') && hasFilterCategory(c, 'android.intent.category.LAUNCHER')
  );
  if (!launcherAct) {
    const alias = (appNode.children || []).find(
      c => c.name === 'activity-alias' && hasFilterAction(c, 'android.intent.action.MAIN') && hasFilterCategory(c, 'android.intent.category.LAUNCHER')
    );
    if (alias) {
      const targetAttr = (alias.attributes || []).find(
        a => a.resourceId === KNOWN_RES_IDS.targetActivity || (a.name === 'targetActivity' && a.namespace === ANDROID_NS)
      );
      if (targetAttr && targetAttr.value) {
        launcherAct = (appNode.children || []).find(
          c => c.name === 'activity' && getAndroidNameAttr(c)?.value === String(targetAttr.value)
        );
      }
    }
  }
  if (!launcherAct) {
    launcherAct = (appNode.children || []).find(c => c.name === 'activity');
  }
  if (launcherAct) {
    const expAttr = (launcherAct.attributes || []).find(
      a => a.resourceId === KNOWN_RES_IDS.exported || (a.name === 'exported' && a.namespace === ANDROID_NS)
    );
    if (expAttr) {
      expAttr.type = 0x12;
      expAttr.rawValue = 'true';
      expAttr.value = true;
      expAttr.data = 0xffffffff;
      expAttr.resourceId = KNOWN_RES_IDS.exported;
    } else {
      launcherAct.attributes = launcherAct.attributes || [];
      launcherAct.attributes.push(makeAttrBool('exported', true));
    }
    const alreadyHasRokbotDeepLink = (launcherAct.children || []).some(
      f => f.name === 'intent-filter' && (f.children || []).some(
        d => d.name === 'data' && (d.attributes || []).some(
          a => (a.resourceId === KNOWN_RES_IDS.scheme || a.name === 'scheme') && a.value === 'rokbot-local'
        )
      )
    );
    if (!alreadyHasRokbotDeepLink) {
      launcherAct.children = launcherAct.children || [];
      launcherAct.children.push(
        makeEl('intent-filter', [], [
          makeEl('action', [makeAttrStr('name', 'android.intent.action.VIEW')]),
          makeEl('category', [makeAttrStr('name', 'android.intent.category.DEFAULT')]),
          makeEl('category', [makeAttrStr('name', 'android.intent.category.BROWSABLE')]),
          makeEl('data', [makeAttrStr('scheme', 'rokbot-local'), makeAttrStr('host', 'agent')]),
          makeEl('data', [makeAttrStr('scheme', 'rokbot-local'), makeAttrStr('host', 'chat')]),
          makeEl('data', [makeAttrStr('scheme', 'grokbot'), makeAttrStr('host', 'app')]),
        ])
      );
    }
  }

  upsertAppChild('activity', 'dev.rokbot.nativeapp.LibraryActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.LibraryActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.PushSettingsActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.PushSettingsActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.ProfileActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.ProfileActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.UpdateActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.UpdateActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.AvatarStyleActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.AvatarStyleActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.UsageActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.UsageActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.ComputersActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.ComputersActivity'),
    makeAttrBool('exported', false),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.ComputerViewerActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.ComputerViewerActivity'),
    makeAttrBool('exported', false),
    makeAttrHex('windowSoftInputMode', 0x00000010),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.ModelsActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.ModelsActivity'),
    makeAttrBool('exported', false),
    makeAttrHex('windowSoftInputMode', 0x00000010),
  ]);

  upsertAppChild('activity', 'dev.rokbot.nativeapp.CreateGroupActivity', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.CreateGroupActivity'),
    makeAttrBool('exported', false),
    makeAttrHex('windowSoftInputMode', 0x00000010),
  ]);

  upsertAppChild(
    'activity',
    'dev.rokbot.nativeapp.ShareTargetActivity',
    [
      makeAttrStr('name', 'dev.rokbot.nativeapp.ShareTargetActivity'),
      makeAttrBool('exported', true),
      makeAttrHex('windowSoftInputMode', 0x00000010),
    ],
    [
      makeEl('intent-filter', [], [
        makeEl('action', [makeAttrStr('name', 'android.intent.action.SEND')]),
        makeEl('category', [makeAttrStr('name', 'android.intent.category.DEFAULT')]),
        makeEl('data', [makeAttrStr('mimeType', 'text/plain')]),
        makeEl('data', [makeAttrStr('mimeType', 'image/*')]),
        makeEl('data', [makeAttrStr('mimeType', '*/*')]),
      ]),
      makeEl('intent-filter', [], [
        makeEl('action', [makeAttrStr('name', 'android.intent.action.SEND_MULTIPLE')]),
        makeEl('category', [makeAttrStr('name', 'android.intent.category.DEFAULT')]),
        makeEl('data', [makeAttrStr('mimeType', 'image/*')]),
        makeEl('data', [makeAttrStr('mimeType', '*/*')]),
      ]),
    ]
  );

  // 5. Inject NotificationService (dataSync = 0x1) & VoiceCallService (microphone = 0x80)
  const notifServiceName = options.notificationService || 'dev.rokbot.nativeapp.NotificationService';
  upsertAppChild('service', notifServiceName, [
    makeAttrStr('name', notifServiceName),
    makeAttrBool('exported', false),
    makeAttrHex('foregroundServiceType', 0x00000001),
  ]);

  upsertAppChild('service', 'dev.rokbot.nativeapp.VoiceCallService', [
    makeAttrStr('name', 'dev.rokbot.nativeapp.VoiceCallService'),
    makeAttrBool('exported', false),
    makeAttrHex('foregroundServiceType', 0x00000080),
  ]);

  // 6. Inject BootReceiver & UnifiedPushReceiver
  upsertAppChild(
    'receiver',
    'dev.rokbot.nativeapp.BootReceiver',
    [
      makeAttrStr('name', 'dev.rokbot.nativeapp.BootReceiver'),
      makeAttrBool('exported', true),
    ],
    [
      makeEl('intent-filter', [], [
        makeEl('action', [makeAttrStr('name', 'android.intent.action.BOOT_COMPLETED')]),
        makeEl('action', [makeAttrStr('name', 'android.intent.action.MY_PACKAGE_REPLACED')]),
      ]),
    ]
  );

  upsertAppChild(
    'receiver',
    'dev.rokbot.nativeapp.UnifiedPushReceiver',
    [
      makeAttrStr('name', 'dev.rokbot.nativeapp.UnifiedPushReceiver'),
      makeAttrBool('exported', true),
    ],
    [
      makeEl('intent-filter', [], [
        makeEl('action', [makeAttrStr('name', 'org.unifiedpush.android.connector.MESSAGE')]),
        makeEl('action', [makeAttrStr('name', 'org.unifiedpush.android.connector.NEW_ENDPOINT')]),
        makeEl('action', [makeAttrStr('name', 'org.unifiedpush.android.connector.UNREGISTERED')]),
        makeEl('action', [makeAttrStr('name', 'org.unifiedpush.android.connector.REGISTRATION_FAILED')]),
      ]),
    ]
  );

  // 7. Injected Permissions (merge caller options.permissions with required companion permissions)
  const defaultPermissions = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
    'android.permission.WAKE_LOCK',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.REQUEST_INSTALL_PACKAGES',
  ];
  const requiredPermissions = Array.from(new Set([
    ...(options.permissions || []),
    ...defaultPermissions,
  ]));

  const existingPermissions = new Set();
  for (const child of root.children) {
    if (child.name === 'uses-permission' && child.attributes) {
      const nameAttr = child.attributes.find(
        a => a.name === 'name' && a.namespace === ANDROID_NS
      );
      if (nameAttr) existingPermissions.add(String(nameAttr.value));
    }
  }

  for (const perm of requiredPermissions) {
    if (!existingPermissions.has(perm)) {
      root.children.push({
        type: 'element',
        name: 'uses-permission',
        namespace: null,
        lineNumber: 5,
        attributes: [
          makeAttrStr('name', perm),
        ],
        children: [],
      });
      existingPermissions.add(perm);
    }
  }

  return serializeAxml(ast);
}
