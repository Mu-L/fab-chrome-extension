// Strict Epic binary/JSON manifest and chunk parser for browser and Node.

const MANIFEST_MAGIC = 0x44bec00c;
const CHUNK_MAGIC = 0xb1fe3aa2;
const STORED_COMPRESSED = 0x01;
const STORED_ENCRYPTED = 0x02;
const STORED_KNOWN_MASK = STORED_COMPRESSED | STORED_ENCRYPTED;
const LEGACY_CHUNK_WINDOW = 1024 * 1024;

const MiB = 1024 * 1024;
const MAX_RAW_MANIFEST_BYTES = 64 * MiB;
const MAX_JSON_MANIFEST_BYTES = 32 * MiB;
const MAX_MANIFEST_BODY_BYTES = 128 * MiB;
const MAX_COMPRESSED_CHUNK_BYTES = 64 * MiB;
const MAX_CHUNK_PAYLOAD_BYTES = 128 * MiB;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_FSTRING_BYTES = 256 * 1024;
const MAX_JSON_STRING_CHARS = 256 * 1024;
const MAX_CHUNKS = 65_536;
const MAX_FILES = 65_536;
const MAX_TOTAL_CHUNK_PARTS = 524_288;
const MAX_INSTALL_TAGS_PER_FILE = 4_096;
const MAX_TOTAL_INSTALL_TAGS = 262_144;
const MAX_PREREQ_IDS = 16_384;
const MAX_CUSTOM_FIELDS = 16_384;
const MAX_EXTENSION_SECTIONS = 16;
// Feature 22 adds chunk encryption metadata. This downloader intentionally
// supports only the fully understood, unencrypted binary generations.
const MAX_BINARY_FEATURE_LEVEL = 21;

function asUint8Array(value, label = 'data') {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${label} must be an ArrayBuffer or typed-array view`);
}

function assertInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function checkedAdd(a, b, label) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return result;
}

function checkedCount(value, max, label, minimumBytes = 0, remainingBytes = Infinity) {
  assertInteger(value, 0, max, label);
  if (minimumBytes > 0 && value > Math.floor(remainingBytes / minimumBytes)) {
    throw new Error(`${label} cannot fit inside its declared section`);
  }
  return value;
}

function parserAbortError() {
  return new DOMException('Parsing cancelled', 'AbortError');
}

function throwIfParsingAborted(signal) {
  if (signal?.aborted) throw parserAbortError();
}

async function cooperativeCheckpoint(signal, index) {
  throwIfParsingAborted(signal);
  if (index > 0 && index % 2_048 === 0) {
    await new Promise(resolve => setTimeout(resolve, 0));
    throwIfParsingAborted(signal);
  }
}

class Reader {
  constructor(bytes, start = 0, end = bytes.byteLength, label = 'binary data') {
    this.bytesView = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.start = start;
    this.end = end;
    this.offset = start;
    this.label = label;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start || end > bytes.byteLength) {
      throw new Error(`Invalid ${label} bounds`);
    }
  }

  get pos() { return this.offset; }
  remaining() { return this.end - this.offset; }

  ensure(length, operation = 'read') {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
      throw new Error(`${this.label}: ${operation} exceeds declared bounds at byte ${this.offset}`);
    }
  }

  seek(position) {
    if (!Number.isSafeInteger(position) || position < this.start || position > this.end) {
      throw new Error(`${this.label}: invalid seek to byte ${position}`);
    }
    this.offset = position;
  }

  skip(length) {
    this.ensure(length, 'skip');
    this.offset += length;
  }

  u8() {
    this.ensure(1);
    return this.view.getUint8(this.offset++);
  }

  u32() {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32() {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64Big() {
    this.ensure(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  u64Safe(label) {
    const value = this.u64Big();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} exceeds JavaScript's safe integer range`);
    }
    return Number(value);
  }

  bytes(length, copy = true) {
    this.ensure(length);
    const value = this.bytesView.subarray(this.offset, this.offset + length);
    this.offset += length;
    return copy ? value.slice() : value;
  }

  fstring(label = 'string') {
    const length = this.i32();
    if (length === 0) return '';

    if (length > 0) {
      if (length > MAX_FSTRING_BYTES + 1) throw new Error(`${label} is too long`);
      const encoded = this.bytes(length, false);
      if (encoded[encoded.length - 1] !== 0) throw new Error(`${label} has no null terminator`);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, -1));
      } catch (error) {
        throw new Error(`${label} is not valid UTF-8: ${error.message}`);
      }
    }

    if (length === -0x80000000) throw new Error(`${label} has an invalid length`);
    const codeUnits = -length;
    if (codeUnits > Math.floor(MAX_FSTRING_BYTES / 2) + 1) throw new Error(`${label} is too long`);
    const byteLength = codeUnits * 2;
    const encoded = this.bytes(byteLength, false);
    if (encoded[byteLength - 2] !== 0 || encoded[byteLength - 1] !== 0) {
      throw new Error(`${label} has no UTF-16 null terminator`);
    }
    try {
      return new TextDecoder('utf-16le', { fatal: true }).decode(encoded.subarray(0, -2));
    } catch (error) {
      throw new Error(`${label} is not valid UTF-16LE: ${error.message}`);
    }
  }

  section(label) {
    const sectionStart = this.offset;
    const size = this.u32();
    if (size < 4) throw new Error(`${label} section size is smaller than its header`);
    if (size > this.end - sectionStart) throw new Error(`${label} section exceeds parent bounds`);
    const sectionEnd = sectionStart + size;
    this.offset = sectionEnd;
    return new Reader(this.bytesView, sectionStart + 4, sectionEnd, `${label} section`);
  }
}

function hasZlibHeader(data) {
  if (data.byteLength < 2) return false;
  const cmf = data[0];
  const flg = data[1];
  return (cmf & 0x0f) === 8 && (cmf >> 4) <= 7 && (((cmf << 8) | flg) % 31) === 0;
}

async function decompressStream(input, format, maxOutputBytes, expectedBytes, label) {
  let transform;
  try {
    transform = new DecompressionStream(format);
  } catch (error) {
    throw new Error(`${label} decompression format ${format} is unavailable: ${error.message}`);
  }

  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  const fixedOutput = expectedBytes === null ? null : new Uint8Array(expectedBytes);
  const chunks = fixedOutput ? null : [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = asUint8Array(value, `${label} decompressed block`);
      const nextTotal = checkedAdd(total, chunk.byteLength, `${label} decompressed size`);
      if (nextTotal > maxOutputBytes || (fixedOutput && nextTotal > fixedOutput.byteLength)) {
        await reader.cancel(`${label} decompressed output exceeds its limit`);
        throw new Error(`${label} decompressed output exceeds its declared or configured limit`);
      }
      if (fixedOutput) fixedOutput.set(chunk, total);
      else chunks.push(chunk);
      total = nextTotal;
    }
  } catch (error) {
    throw new Error(`${label} decompression failed: ${error.message}`);
  } finally {
    reader.releaseLock();
  }

  if (expectedBytes !== null && total !== expectedBytes) {
    throw new Error(`${label} decompressed size mismatch: expected ${expectedBytes}, got ${total}`);
  }
  if (fixedOutput) return fixedOutput;

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function decompressDeflate(data, maxOutputBytes, expectedBytes, label) {
  if (data.byteLength === 0) throw new Error(`${label} compressed input is empty`);
  const format = hasZlibHeader(data) ? 'deflate' : 'deflate-raw';
  return decompressStream(data, format, maxOutputBytes, expectedBytes, label);
}

// A bounded, true incremental SHA-1 implementation. Only a single 64-byte block
// and the 80-word SHA schedule are retained, regardless of input size.
export class IncrementalSHA1 {
  constructor() {
    this.h0 = 0x67452301;
    this.h1 = 0xefcdab89;
    this.h2 = 0x98badcfe;
    this.h3 = 0x10325476;
    this.h4 = 0xc3d2e1f0;
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0n;
    this.words = new Uint32Array(80);
    this.finished = false;
    this.result = null;
  }

  update(value) {
    if (this.finished) throw new Error('SHA-1 has already been finalized');
    const data = asUint8Array(value, 'SHA-1 input');
    this.bytesHashed += BigInt(data.byteLength);
    let offset = 0;

    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      const take = Math.min(needed, data.byteLength);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= data.byteLength) {
      this.processBlock(data, offset);
      offset += 64;
    }

    if (offset < data.byteLength) {
      const tail = data.subarray(offset);
      this.buffer.set(tail, 0);
      this.bufferLength = tail.byteLength;
    }
    return this;
  }

  async updateAsync(value, { signal = null, sliceBytes = MiB } = {}) {
    const data = asUint8Array(value, 'SHA-1 input');
    assertInteger(sliceBytes, 64, 8 * MiB, 'SHA-1 slice size');
    for (let offset = 0; offset < data.byteLength; offset += sliceBytes) {
      throwIfParsingAborted(signal);
      this.update(data.subarray(offset, Math.min(offset + sliceBytes, data.byteLength)));
      if (offset + sliceBytes < data.byteLength) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    throwIfParsingAborted(signal);
    return this;
  }

  processBlock(data, offset) {
    const words = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] = (
        (data[j] << 24)
        | (data[j + 1] << 16)
        | (data[j + 2] << 8)
        | data[j + 3]
      ) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      const value = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = ((value << 1) | (value >>> 31)) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;

    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const rotatedA = ((a << 5) | (a >>> 27)) >>> 0;
      const next = (rotatedA + (f >>> 0) + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = next;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
  }

  async digest() {
    if (this.result !== null) return this.result;
    this.finished = true;
    const bitLength = this.bytesHashed * 8n;

    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength, 64);
      this.processBlock(this.buffer, 0);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    for (let i = 0; i < 8; i++) {
      this.buffer[63 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
    }
    this.processBlock(this.buffer, 0);
    this.bufferLength = 0;

    this.result = [this.h0, this.h1, this.h2, this.h3, this.h4]
      .map(value => value.toString(16).padStart(8, '0'))
      .join('');
    return this.result;
  }
}

async function sha1Hex(data, signal = null) {
  const hasher = new IncrementalSHA1();
  await hasher.updateAsync(data, { signal });
  return hasher.digest();
}

function guidString(a, b, c, d) {
  return [a, b, c, d].map(part => part.toString(16).toUpperCase().padStart(8, '0')).join('');
}

function readGuid(reader) {
  return guidString(reader.u32(), reader.u32(), reader.u32(), reader.u32());
}

function bytesToHex(bytes) {
  let output = '';
  for (const value of bytes) output += value.toString(16).padStart(2, '0');
  return output;
}

function uint64Hex(value) {
  return value.toString(16).toUpperCase().padStart(16, '0');
}

function normalizeGuid(value, label = 'GUID') {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.replace(/-/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(normalized)) throw new Error(`${label} is malformed`);
  return normalized;
}

function normalizeSha(value, label, allowMissing = true) {
  if (value === undefined || value === null || value === '') {
    if (allowMissing) return '';
    throw new Error(`${label} is missing`);
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (/^[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (/^\d{60}$/.test(value)) return bytesToHex(decodeDecimalBytes(value, 20, label));
  throw new Error(`${label} must be a 20-byte SHA-1`);
}

function isNonZeroSha(value) {
  return /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
}

function decodeDecimalBytes(value, expectedLength, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 3 !== 0) {
    throw new Error(`${label} is not a decimal-encoded byte string`);
  }
  const byteLength = value.length / 3;
  if (expectedLength !== null && byteLength !== expectedLength) {
    throw new Error(`${label} must contain exactly ${expectedLength} bytes`);
  }
  const result = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    const triplet = value.slice(i * 3, i * 3 + 3);
    if (!/^\d{3}$/.test(triplet)) throw new Error(`${label} contains a non-decimal triplet`);
    const byte = Number(triplet);
    if (byte > 255) throw new Error(`${label} contains a byte greater than 255`);
    result[i] = byte;
  }
  return result;
}

function decodeDecimalUint32(value, label) {
  const bytes = decodeDecimalBytes(value, 4, label);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

function decodeDecimalUint64Big(value, label) {
  const bytes = decodeDecimalBytes(value, 8, label);
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
}

function uint64BigToSafe(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label, maxLength) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  checkedCount(value.length, maxLength, `${label} count`);
  return value;
}

function requireString(value, label, allowMissing = false) {
  if (value === undefined && allowMissing) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.length > MAX_JSON_STRING_CHARS) throw new Error(`${label} is too long`);
  return value;
}

function normalizedGuidMap(value, label, maxEntries = MAX_CHUNKS) {
  const object = requireObject(value, label);
  const keys = Object.keys(object);
  checkedCount(keys.length, maxEntries, `${label} count`);
  const result = new Map();
  for (const rawGuid of keys) {
    const guid = normalizeGuid(rawGuid, `${label} key`);
    if (result.has(guid)) throw new Error(`${label} contains duplicate GUID ${guid}`);
    result.set(guid, object[rawGuid]);
  }
  return result;
}

/** Parse a binary or JSON manifest from raw bytes. */
export async function parseManifestFromBytes(value, { signal = null } = {}) {
  throwIfParsingAborted(signal);
  const bytes = asUint8Array(value, 'Manifest');
  if (bytes.byteLength === 0) throw new Error('Manifest is empty');
  if (bytes.byteLength > MAX_RAW_MANIFEST_BYTES) {
    throw new Error(`Manifest exceeds ${MAX_RAW_MANIFEST_BYTES} bytes`);
  }

  let first = 0;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) first = 3;
  while (first < bytes.byteLength
      && (bytes[first] === 0x20 || bytes[first] === 0x09
        || bytes[first] === 0x0a || bytes[first] === 0x0d)) first++;
  if (bytes[first] === 0x7b) {
    if (bytes.byteLength > MAX_JSON_MANIFEST_BYTES) {
      throw new Error(`JSON manifest exceeds ${MAX_JSON_MANIFEST_BYTES} bytes`);
    }
    return parseJsonManifest(bytes, signal);
  }

  if (bytes.byteLength < 37) throw new Error('Binary manifest is shorter than its minimum header');
  const reader = new Reader(bytes, 0, bytes.byteLength, 'manifest header');
  const magic = reader.u32();
  if (magic !== MANIFEST_MAGIC) throw new Error(`Bad manifest magic: 0x${magic.toString(16)}`);

  const headerSize = reader.u32();
  const uncompressedSize = reader.u32();
  const compressedSize = reader.u32();
  const expectedSha = bytesToHex(reader.bytes(20));
  const storedAs = reader.u8();
  if ((storedAs & ~STORED_KNOWN_MASK) !== 0) throw new Error('Manifest has unknown storage flags');
  if ((storedAs & STORED_ENCRYPTED) !== 0) throw new Error('Encrypted manifests are not supported');
  if (headerSize < 37 || headerSize > MAX_HEADER_BYTES || headerSize > bytes.byteLength) {
    throw new Error('Manifest header size is invalid');
  }
  if (headerSize > 37 && headerSize < 41) throw new Error('Manifest header is missing part of its version');

  let headerVersion = null;
  if (headerSize >= 41) {
    headerVersion = reader.u32();
    assertInteger(headerVersion, 0, MAX_BINARY_FEATURE_LEVEL, 'Manifest feature level');
    if (headerSize !== 41) {
      throw new Error(`Manifest feature level ${headerVersion} has an unsupported header layout`);
    }
  } else if (headerSize !== 37) {
    throw new Error('Legacy manifest has an unsupported header layout');
  }
  reader.seek(headerSize);

  if (compressedSize > MAX_RAW_MANIFEST_BYTES) throw new Error('Manifest compressed body is too large');
  if (uncompressedSize > MAX_MANIFEST_BODY_BYTES) throw new Error('Manifest decompressed body is too large');
  const bodyBytes = reader.bytes(reader.remaining(), false);
  if (bodyBytes.byteLength !== compressedSize) {
    throw new Error(`Manifest compressed size mismatch: expected ${compressedSize}, got ${bodyBytes.byteLength}`);
  }

  let body;
  if ((storedAs & STORED_COMPRESSED) !== 0) {
    body = await decompressDeflate(
      bodyBytes,
      MAX_MANIFEST_BODY_BYTES,
      uncompressedSize,
      'Manifest body',
    );
  } else {
    if (bodyBytes.byteLength !== uncompressedSize) {
      throw new Error(`Manifest body size mismatch: expected ${uncompressedSize}, got ${bodyBytes.byteLength}`);
    }
    body = bodyBytes;
  }
  throwIfParsingAborted(signal);

  if (isNonZeroSha(expectedSha)) {
    const actualSha = await sha1Hex(body, signal);
    if (actualSha !== expectedSha) throw new Error('Manifest body SHA-1 mismatch');
  }
  return readBinaryBody(body, headerVersion, signal);
}

async function parseJsonManifest(bytes, signal) {
  throwIfParsingAborted(signal);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`JSON manifest is not valid UTF-8: ${error.message}`);
  }

  let manifest;
  try {
    manifest = requireObject(JSON.parse(text), 'JSON manifest');
  } catch (error) {
    throw new Error(`Invalid JSON manifest: ${error.message}`);
  }
  text = '';
  throwIfParsingAborted(signal);

  let version = decodeDecimalUint32(
    requireString(manifest.ManifestFileVersion, 'ManifestFileVersion'),
    'ManifestFileVersion',
  );
  if (version === 255) version = 8; // Epic's documented broken JSON feature level.
  if (version > 13) throw new Error(`Unsupported JSON manifest feature level ${version}`);

  const files = requireArray(manifest.FileManifestList, 'FileManifestList', MAX_FILES);
  const hashMap = normalizedGuidMap(manifest.ChunkHashList, 'ChunkHashList');
  const shaMap = normalizedGuidMap(manifest.ChunkShaList ?? {}, 'ChunkShaList');
  const fileSizeMap = normalizedGuidMap(manifest.ChunkFilesizeList, 'ChunkFilesizeList');
  const groupMap = normalizedGuidMap(manifest.DataGroupList, 'DataGroupList');

  for (const guid of shaMap.keys()) {
    if (!hashMap.has(guid)) throw new Error(`ChunkShaList contains unknown GUID ${guid}`);
  }
  for (const guid of fileSizeMap.keys()) {
    if (!hashMap.has(guid)) throw new Error(`ChunkFilesizeList contains unknown GUID ${guid}`);
  }
  for (const guid of groupMap.keys()) {
    if (!hashMap.has(guid)) throw new Error(`DataGroupList contains unknown GUID ${guid}`);
  }

  const chunkDataList = [];
  const chunkByGuid = new Map();
  let chunkIndex = 0;
  for (const [guid, encodedHash] of hashMap) {
    await cooperativeCheckpoint(signal, chunkIndex++);
    if (!fileSizeMap.has(guid)) throw new Error(`Chunk ${guid} has no declared file size`);
    if (!groupMap.has(guid)) throw new Error(`Chunk ${guid} has no data group`);

    const hash = uint64Hex(decodeDecimalUint64Big(encodedHash, `Chunk ${guid} rolling hash`));
    const fileSize = uint64BigToSafe(
      decodeDecimalUint64Big(fileSizeMap.get(guid), `Chunk ${guid} file size`),
      `Chunk ${guid} file size`,
    );
    if (fileSize > MAX_CHUNK_PAYLOAD_BYTES + MAX_HEADER_BYTES) {
      throw new Error(`Chunk ${guid} declared file size exceeds the configured limit`);
    }

    const rawGroup = requireString(groupMap.get(guid), `Chunk ${guid} data group`);
    if (!/^\d{1,3}$/.test(rawGroup)) throw new Error(`Chunk ${guid} data group is malformed`);
    const groupNumber = Number(rawGroup);
    assertInteger(groupNumber, 0, 255, `Chunk ${guid} data group`);
    const shaHash = shaMap.has(guid)
      ? normalizeSha(shaMap.get(guid), `Chunk ${guid} SHA-1`, false)
      : '';

    const entry = {
      guid,
      hash,
      shaHash,
      groupNumber,
      windowSize: LEGACY_CHUNK_WINDOW,
      fileSize,
    };
    chunkDataList.push(entry);
    chunkByGuid.set(guid, entry);
  }

  const fileManifestList = [];
  let totalParts = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    await cooperativeCheckpoint(signal, fileIndex);
    const file = requireObject(files[fileIndex], `FileManifestList[${fileIndex}]`);
    const filename = requireString(file.Filename, `FileManifestList[${fileIndex}].Filename`);
    const symlinkTarget = requireString(
      file.SymlinkTarget ?? '',
      `FileManifestList[${fileIndex}].SymlinkTarget`,
      true,
    );
    if (symlinkTarget) throw new Error(`Symlink entries are not supported: ${filename}`);
    const rawParts = requireArray(
      file.FileChunkParts,
      `FileManifestList[${fileIndex}].FileChunkParts`,
      MAX_TOTAL_CHUNK_PARTS,
    );
    totalParts = checkedAdd(totalParts, rawParts.length, 'Total chunk-part count');
    if (totalParts > MAX_TOTAL_CHUNK_PARTS) throw new Error('Manifest has too many chunk parts');

    const chunkParts = [];
    let fileSize = 0;
    for (let partIndex = 0; partIndex < rawParts.length; partIndex++) {
      await cooperativeCheckpoint(signal, totalParts - rawParts.length + partIndex);
      const part = requireObject(
        rawParts[partIndex],
        `FileManifestList[${fileIndex}].FileChunkParts[${partIndex}]`,
      );
      const guid = normalizeGuid(part.Guid, `Chunk part ${fileIndex}:${partIndex} GUID`);
      const chunk = chunkByGuid.get(guid);
      if (!chunk) throw new Error(`File ${filename} references unknown chunk ${guid}`);
      const offset = decodeDecimalUint32(part.Offset, `Chunk part ${fileIndex}:${partIndex} offset`);
      const size = decodeDecimalUint32(part.Size, `Chunk part ${fileIndex}:${partIndex} size`);
      if (size === 0) throw new Error(`Chunk part ${fileIndex}:${partIndex} is empty`);
      const end = checkedAdd(offset, size, `Chunk part ${fileIndex}:${partIndex} range`);
      if (end > chunk.windowSize || end > MAX_CHUNK_PAYLOAD_BYTES) {
        throw new Error(`Chunk part ${fileIndex}:${partIndex} exceeds chunk ${guid}`);
      }
      fileSize = checkedAdd(fileSize, size, `File ${filename} size`);
      chunkParts.push({ guid, offset, size });
    }

    const fileHash = normalizeSha(file.FileHash, `File ${filename} SHA-1`);
    fileManifestList.push({ filename, fileSize, fileHash, chunkParts });
  }

  return {
    version,
    buildVersion: requireString(
      manifest.BuildVersionString ?? '',
      'BuildVersionString',
      true,
    ),
    chunkDataList,
    fileManifestList,
  };
}

async function readBinaryBody(body, headerVersion, signal) {
  throwIfParsingAborted(signal);
  const reader = new Reader(body, 0, body.byteLength, 'manifest body');

  const meta = reader.section('metadata');
  const metaVersion = meta.u8();
  if (metaVersion > 2) throw new Error(`Unsupported metadata version ${metaVersion}`);
  const featureLevel = meta.u32();
  assertInteger(featureLevel, 0, MAX_BINARY_FEATURE_LEVEL, 'Metadata feature level');
  if (headerVersion !== null && headerVersion !== featureLevel) {
    throw new Error(`Manifest feature level mismatch: header ${headerVersion}, metadata ${featureLevel}`);
  }
  if (featureLevel >= 14 && headerVersion === null) {
    throw new Error(`Manifest feature level ${featureLevel} requires a versioned 41-byte header`);
  }
  if (featureLevel < 14 && headerVersion !== null) {
    throw new Error(`Manifest feature level ${featureLevel} requires the legacy 37-byte header`);
  }
  meta.u8(); // bIsFileData
  meta.u32(); // App ID
  meta.fstring('App name');
  const buildVersion = meta.fstring('Build version');
  meta.fstring('Launch executable');
  meta.fstring('Launch command');
  const prereqCount = checkedCount(meta.u32(), MAX_PREREQ_IDS, 'Prerequisite ID count', 4, meta.remaining());
  for (let i = 0; i < prereqCount; i++) meta.fstring(`Prerequisite ID ${i}`);
  meta.fstring('Prerequisite name');
  meta.fstring('Prerequisite path');
  meta.fstring('Prerequisite arguments');
  if (metaVersion >= 1) meta.fstring('Build ID');
  if (metaVersion >= 2) {
    meta.fstring('Uninstall action path');
    meta.fstring('Uninstall action arguments');
  }
  meta.seek(meta.end);

  const chunkSection = reader.section('chunk data list');
  const chunkDataVersion = chunkSection.u8();
  if (chunkDataVersion !== 0) {
    throw new Error(`Unsupported chunk data list version ${chunkDataVersion}`);
  }
  const chunkRecordBytes = featureLevel >= 16 ? 57 : 53;
  const chunkCount = checkedCount(
    chunkSection.u32(),
    MAX_CHUNKS,
    'Chunk count',
    chunkRecordBytes,
    chunkSection.remaining(),
  );
  const chunks = Array.from({ length: chunkCount }, () => ({
    guid: '',
    hash: 0n,
    shaHash: '',
    groupNumber: 0,
    windowSize: LEGACY_CHUNK_WINDOW,
    fileSize: 0,
  }));
  const chunkByGuid = new Map();

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    await cooperativeCheckpoint(signal, chunkIndex);
    const chunk = chunks[chunkIndex];
    chunk.guid = readGuid(chunkSection);
    if (chunkByGuid.has(chunk.guid)) throw new Error(`Duplicate chunk GUID ${chunk.guid}`);
    chunkByGuid.set(chunk.guid, chunk);
  }
  for (const chunk of chunks) chunk.hash = chunkSection.u64Big();
  for (const chunk of chunks) chunk.shaHash = bytesToHex(chunkSection.bytes(20));
  for (const chunk of chunks) chunk.groupNumber = chunkSection.u8();
  if (featureLevel >= 16) {
    for (const chunk of chunks) {
      chunk.windowSize = chunkSection.u32();
      if (chunk.windowSize === 0 || chunk.windowSize > MAX_CHUNK_PAYLOAD_BYTES) {
        throw new Error(`Chunk ${chunk.guid} has an invalid window size`);
      }
    }
  }
  for (const chunk of chunks) {
    chunk.fileSize = chunkSection.u64Safe(`Chunk ${chunk.guid} file size`);
    if (chunk.fileSize > MAX_CHUNK_PAYLOAD_BYTES + MAX_HEADER_BYTES) {
      throw new Error(`Chunk ${chunk.guid} declared file size exceeds the configured limit`);
    }
  }
  chunkSection.seek(chunkSection.end);

  const fileSection = reader.section('file manifest list');
  const fileDataVersion = fileSection.u8();
  if (fileDataVersion > 2) throw new Error(`Unsupported file manifest list version ${fileDataVersion}`);
  const fileCount = checkedCount(fileSection.u32(), MAX_FILES, 'File count', 4, fileSection.remaining());
  const files = Array.from({ length: fileCount }, () => ({
    filename: '',
    fileHash: '',
    chunkParts: [],
    fileSize: 0,
  }));

  for (const file of files) file.filename = fileSection.fstring('Filename');
  for (let i = 0; i < files.length; i++) {
    const symlinkTarget = fileSection.fstring(`Symlink target ${i}`);
    if (symlinkTarget) throw new Error(`Symlink entries are not supported: ${files[i].filename}`);
  }
  for (const file of files) file.fileHash = bytesToHex(fileSection.bytes(20));
  for (let i = 0; i < files.length; i++) {
    const flags = fileSection.u8();
    if ((flags & ~0x07) !== 0) throw new Error(`File ${files[i].filename} has unknown metadata flags`);
  }

  let totalTags = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    await cooperativeCheckpoint(signal, fileIndex);
    const tagCount = checkedCount(
      fileSection.u32(),
      MAX_INSTALL_TAGS_PER_FILE,
      `Install-tag count for file ${fileIndex}`,
      4,
      fileSection.remaining(),
    );
    totalTags = checkedAdd(totalTags, tagCount, 'Total install-tag count');
    if (totalTags > MAX_TOTAL_INSTALL_TAGS) throw new Error('Manifest has too many install tags');
    for (let i = 0; i < tagCount; i++) fileSection.fstring(`Install tag ${fileIndex}:${i}`);
  }

  let totalParts = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    await cooperativeCheckpoint(signal, fileIndex);
    const file = files[fileIndex];
    const partCount = checkedCount(
      fileSection.u32(),
      MAX_TOTAL_CHUNK_PARTS,
      `Chunk-part count for file ${fileIndex}`,
      28,
      fileSection.remaining(),
    );
    totalParts = checkedAdd(totalParts, partCount, 'Total chunk-part count');
    if (totalParts > MAX_TOTAL_CHUNK_PARTS) throw new Error('Manifest has too many chunk parts');

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      await cooperativeCheckpoint(signal, totalParts - partCount + partIndex);
      const partSection = fileSection.section(`chunk part ${fileIndex}:${partIndex}`);
      if (partSection.remaining() < 24) throw new Error(`Chunk part ${fileIndex}:${partIndex} is too short`);
      const guid = readGuid(partSection);
      const offset = partSection.u32();
      const size = partSection.u32();
      if (size === 0) throw new Error(`Chunk part ${fileIndex}:${partIndex} is empty`);
      const chunk = chunkByGuid.get(guid);
      if (!chunk) throw new Error(`File ${file.filename} references unknown chunk ${guid}`);
      const end = checkedAdd(offset, size, `Chunk part ${fileIndex}:${partIndex} range`);
      if (end > chunk.windowSize || end > MAX_CHUNK_PAYLOAD_BYTES) {
        throw new Error(`Chunk part ${fileIndex}:${partIndex} exceeds chunk ${guid}`);
      }
      file.fileSize = checkedAdd(file.fileSize, size, `File ${file.filename} size`);
      file.chunkParts.push({ guid, offset, size });
      partSection.seek(partSection.end);
    }
  }
  fileSection.seek(fileSection.end);

  if (reader.remaining() >= 4) {
    const customFields = reader.section('custom fields');
    const customFieldVersion = customFields.u8();
    if (customFieldVersion !== 0) {
      throw new Error(`Unsupported custom-field data version ${customFieldVersion}`);
    }
    const fieldCount = checkedCount(
      customFields.u32(),
      MAX_CUSTOM_FIELDS,
      'Custom-field count',
      8,
      customFields.remaining(),
    );
    for (let i = 0; i < fieldCount; i++) customFields.fstring(`Custom-field key ${i}`);
    for (let i = 0; i < fieldCount; i++) customFields.fstring(`Custom-field value ${i}`);
    customFields.seek(customFields.end);
  }

  let extensionSections = 0;
  while (reader.remaining() > 0) {
    if (reader.remaining() < 4) throw new Error('Manifest has a truncated trailing section');
    extensionSections++;
    if (extensionSections > MAX_EXTENSION_SECTIONS) throw new Error('Manifest has too many trailing sections');
    const extension = reader.section(`extension ${extensionSections}`);
    extension.seek(extension.end);
  }

  return {
    version: featureLevel,
    buildVersion,
    chunkDataList: chunks.map(chunk => ({
      guid: chunk.guid,
      hash: uint64Hex(chunk.hash),
      shaHash: chunk.shaHash,
      groupNumber: chunk.groupNumber,
      windowSize: chunk.windowSize,
      fileSize: chunk.fileSize,
    })),
    fileManifestList: files,
  };
}

function validateExpectedChunk(expected, inputLength, header) {
  if (expected === null || expected === undefined) return;
  if (typeof expected !== 'object') throw new TypeError('Expected chunk metadata must be an object');

  if (expected.guid !== undefined) {
    const expectedGuid = normalizeGuid(expected.guid, 'Expected chunk GUID');
    if (expectedGuid !== header.guid) throw new Error('Chunk header GUID does not match manifest');
  }
  if (expected.hash !== undefined && expected.hash !== null && expected.hash !== '') {
    const expectedHash = String(expected.hash).toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(expectedHash)) throw new Error('Expected chunk rolling hash is malformed');
    if (expectedHash !== header.rollingHash) throw new Error('Chunk rolling hash does not match manifest');
  }
  if (expected.fileSize !== undefined && expected.fileSize !== null && expected.fileSize !== 0) {
    assertInteger(expected.fileSize, 1, MAX_CHUNK_PAYLOAD_BYTES + MAX_HEADER_BYTES, 'Expected chunk file size');
    if (expected.fileSize !== inputLength) throw new Error('Chunk file size does not match manifest');
  }
  if (expected.windowSize !== undefined && expected.windowSize !== null && expected.windowSize !== 0) {
    assertInteger(expected.windowSize, 1, MAX_CHUNK_PAYLOAD_BYTES, 'Expected chunk window size');
    if (header.uncompressedSize !== null && expected.windowSize !== header.uncompressedSize) {
      throw new Error('Chunk uncompressed size does not match manifest');
    }
  }
}

/**
 * Decode and authenticate a chunk. The optional second argument is the chunk
 * metadata entry returned by parseManifestFromBytes().
 */
export async function decodeChunkPayload(value, expected = null, { signal = null } = {}) {
  throwIfParsingAborted(signal);
  const chunkBytes = asUint8Array(value, 'Chunk');
  if (chunkBytes.byteLength < 41) throw new Error('Chunk is shorter than its minimum header');
  if (chunkBytes.byteLength > MAX_CHUNK_PAYLOAD_BYTES + MAX_HEADER_BYTES) {
    throw new Error('Chunk exceeds the configured input limit');
  }

  const reader = new Reader(chunkBytes, 0, chunkBytes.byteLength, 'chunk header');
  const magic = reader.u32();
  if (magic !== CHUNK_MAGIC) throw new Error(`Bad chunk magic: 0x${magic.toString(16)}`);
  const headerVersion = reader.u32();
  if (headerVersion < 1 || headerVersion > 3) {
    throw new Error(`Unsupported chunk header version ${headerVersion}`);
  }
  const headerSize = reader.u32();
  const storedSize = reader.u32();
  const guid = readGuid(reader);
  const rollingHash = uint64Hex(reader.u64Big());
  const storedAs = reader.u8();
  if ((storedAs & ~STORED_KNOWN_MASK) !== 0) throw new Error('Chunk has unknown storage flags');
  if ((storedAs & STORED_ENCRYPTED) !== 0) throw new Error('Encrypted chunks are not supported');

  const expectedHeaderSize = headerVersion === 3 ? 66
      : headerVersion === 2 ? 62
        : 41;
  if (
    headerSize !== expectedHeaderSize ||
    headerSize > MAX_HEADER_BYTES ||
    headerSize > chunkBytes.byteLength
  ) {
    throw new Error('Chunk header size is invalid');
  }

  let headerSha = '';
  let hashType = 0;
  if (headerVersion >= 2) {
    headerSha = bytesToHex(reader.bytes(20));
    hashType = reader.u8();
    if ((hashType & ~0x03) !== 0) throw new Error('Chunk has unknown hash flags');
    if ((hashType & 0x02) !== 0 && !isNonZeroSha(headerSha)) {
      throw new Error('Chunk declares SHA-1 hashing but has no SHA-1 value');
    }
  }

  let uncompressedSize = null;
  if (headerVersion >= 3) {
    uncompressedSize = reader.u32();
    if (uncompressedSize > MAX_CHUNK_PAYLOAD_BYTES) {
      throw new Error('Chunk uncompressed size exceeds the configured limit');
    }
  }
  reader.seek(headerSize);

  const isCompressed = (storedAs & STORED_COMPRESSED) !== 0;
  const storedLimit = isCompressed ? MAX_COMPRESSED_CHUNK_BYTES : MAX_CHUNK_PAYLOAD_BYTES;
  if (storedSize > storedLimit) throw new Error('Chunk stored size exceeds the configured limit');
  const storedPayload = reader.bytes(reader.remaining(), false);
  if (storedPayload.byteLength !== storedSize) {
    throw new Error(`Chunk stored size mismatch: expected ${storedSize}, got ${storedPayload.byteLength}`);
  }

  const header = { guid, rollingHash, uncompressedSize };
  validateExpectedChunk(expected, chunkBytes.byteLength, header);
  const expectedOutputSize = uncompressedSize
    ?? (expected?.windowSize || LEGACY_CHUNK_WINDOW);
  assertInteger(expectedOutputSize, 0, MAX_CHUNK_PAYLOAD_BYTES, 'Chunk uncompressed size');

  let payload;
  if (isCompressed) {
    payload = await decompressDeflate(
      storedPayload,
      MAX_CHUNK_PAYLOAD_BYTES,
      expectedOutputSize,
      'Chunk payload',
    );
  } else {
    if (storedPayload.byteLength !== expectedOutputSize) {
      throw new Error(`Chunk payload size mismatch: expected ${expectedOutputSize}, got ${storedPayload.byteLength}`);
    }
    payload = storedPayload;
  }
  throwIfParsingAborted(signal);

  const expectedManifestSha = expected?.shaHash === undefined
    ? ''
    : normalizeSha(expected.shaHash, 'Expected chunk SHA-1');
  if (isNonZeroSha(headerSha) && isNonZeroSha(expectedManifestSha)
      && headerSha !== expectedManifestSha) {
    throw new Error('Chunk header SHA-1 does not match manifest');
  }
  if (isNonZeroSha(headerSha) || isNonZeroSha(expectedManifestSha)) {
    const actualSha = await sha1Hex(payload, signal);
    if (isNonZeroSha(headerSha) && actualSha !== headerSha) {
      throw new Error('Chunk payload SHA-1 does not match its header');
    }
    if (isNonZeroSha(expectedManifestSha) && actualSha !== expectedManifestSha) {
      throw new Error('Chunk payload SHA-1 does not match manifest');
    }
  }
  return payload;
}

/**
 * Build a CDN chunk URL. Passing query=null omits a signature; passing a
 * string attaches it verbatim (minus leading ?/&), regardless of manifest
 * version. The caller therefore owns the signed-vs-unsigned policy.
 */
export function chunkUrl(chunk, baseUrl, manifestVersion, query = null) {
  if (chunk === null || typeof chunk !== 'object') throw new TypeError('Chunk metadata is required');
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('Chunk base URL is required');
  assertInteger(manifestVersion, 0, MAX_BINARY_FEATURE_LEVEL, 'Manifest version');
  const guid = normalizeGuid(chunk.guid, 'Chunk GUID');
  const hash = String(chunk.hash ?? '').toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(hash)) throw new Error('Chunk rolling hash is malformed');
  const groupNumber = assertInteger(chunk.groupNumber ?? 0, 0, 255, 'Chunk data group');
  if (baseUrl.includes('#')) throw new Error('Chunk base URL must not contain a fragment');

  const base = baseUrl.replace(/\/+$/, '');
  const directory = manifestVersion >= 15 ? 'ChunksV4'
      : manifestVersion >= 6 ? 'ChunksV3'
        : manifestVersion >= 3 ? 'ChunksV2'
          : 'Chunks';
  const group = groupNumber.toString().padStart(2, '0');
  let url = `${base}/${directory}/${group}/${hash}_${guid}.chunk`;

  if (query !== null && query !== undefined && query !== '') {
    if (typeof query !== 'string') throw new TypeError('Chunk URL query must be a string');
    const normalizedQuery = query.replace(/^[?&]+/, '');
    if (normalizedQuery.includes('#')) throw new Error('Chunk URL query must not contain a fragment');
    if (normalizedQuery) url += (url.includes('?') ? '&' : '?') + normalizedQuery;
  }
  return url;
}
