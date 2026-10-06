import { CONFIG } from "../config.js";

const fourCC = (bytes, offset) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));
const validFPS = (fps) => Number.isFinite(fps) && fps > 0 && fps < 1000;

/** Read only box headers and timing tables; skip mdat even if it is several GB. */
export async function readMP4Metadata(file, signal) {
  let bytesRead = 0;
  let boxesRead = 0;
  const read = async (start, length) => {
    signal?.throwIfAborted();
    if (
      start < 0 ||
      length < 0 ||
      start + length > file.size ||
      bytesRead + length > CONFIG.maxMetadataBytes
    ) {
      throw new Error("Metadata read limit");
    }
    bytesRead += length;
    const bytes = new Uint8Array(
      await file.slice(start, start + length).arrayBuffer(),
    );
    signal?.throwIfAborted();
    if (bytes.length !== length) throw new Error("Truncated metadata");
    return bytes;
  };
  const boxes = async (start, end) => {
    const result = [];
    for (let offset = start; offset + 8 <= end; ) {
      if (++boxesRead > CONFIG.maxMetadataBoxes)
        throw new Error("Too many metadata boxes");
      const header = await read(offset, 8);
      const view = new DataView(header.buffer);
      let size = view.getUint32(0);
      let headerSize = 8;
      if (size === 1) {
        const extended = await read(offset + 8, 8);
        size = Number(new DataView(extended.buffer).getBigUint64(0));
        headerSize = 16;
      } else if (size === 0) size = end - offset;
      if (
        !Number.isSafeInteger(size) ||
        size < headerSize ||
        offset + size > end
      )
        throw new Error("Invalid MP4 box");
      result.push({
        type: fourCC(header, 4),
        start: offset + headerSize,
        end: offset + size,
      });
      offset += size;
    }
    return result;
  };
  const child = async (box, type) =>
    box
      ? (await boxes(box.start, box.end)).find((value) => value.type === type)
      : null;
  const root = await boxes(0, file.size);
  const moov = root.find((box) => box.type === "moov");
  if (!moov) return null;
  const tracks = (await boxes(moov.start, moov.end)).filter(
    (box) => box.type === "trak",
  );
  for (const track of tracks) {
    const mdia = await child(track, "mdia");
    const hdlr = await child(mdia, "hdlr");
    if (
      !hdlr ||
      hdlr.end - hdlr.start < 12 ||
      fourCC(await read(hdlr.start, 12), 8) !== "vide"
    )
      continue;
    const mdhd = await child(mdia, "mdhd");
    if (!mdhd || mdhd.end - mdhd.start < 20) continue;
    const version = (await read(mdhd.start, 1))[0];
    if (version !== 0 && version !== 1) continue;
    const scaleOffset = version === 1 ? 20 : 12;
    if (mdhd.start + scaleOffset + 4 > mdhd.end) continue;
    const timescale = new DataView(
      (await read(mdhd.start + scaleOffset, 4)).buffer,
    ).getUint32(0);
    const minf = await child(mdia, "minf");
    const stbl = await child(minf, "stbl");
    const stts = await child(stbl, "stts");
    if (!timescale || !stts || stts.end - stts.start < 8) continue;
    const count = new DataView((await read(stts.start, 8)).buffer).getUint32(4);
    if (!count || count * 8 > stts.end - stts.start - 8) continue;
    const data = new DataView((await read(stts.start + 8, count * 8)).buffer);
    let samples = 0;
    let ticks = 0;
    let firstDelta = null;
    let variableFrameRate = false;
    for (let i = 0; i < count; i++) {
      const n = data.getUint32(i * 8);
      const delta = data.getUint32(i * 8 + 4);
      if (!n) continue;
      if (!delta) return null;
      firstDelta ??= delta;
      variableFrameRate ||= delta !== firstDelta;
      samples += n;
      ticks += n * delta;
    }
    const fps = (samples * timescale) / ticks;
    if (validFPS(fps)) return { fps, variableFrameRate, source: "metadata" };
  }
  return null; // Fragmented MP4 without stts: estimate while playing instead.
}

/** EBML uses arithmetic rather than signed 32-bit shifts for nanosecond values. */
function vint(bytes, offset, id = false) {
  const first = bytes[offset];
  if (!first) return null;
  let mask = 128;
  let length = 1;
  while (!(first & mask)) {
    mask /= 2;
    length++;
  }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = id ? first : first & (mask - 1);
  let unknown = !id && value === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    unknown &&= bytes[offset + i] === 255;
  }
  if (!unknown && !Number.isSafeInteger(value)) return null;
  return { value, length, unknown };
}

function ebmlElements(bytes, start, end) {
  const elements = [];
  for (let offset = start; offset < end; ) {
    const id = vint(bytes, offset, true);
    const size = id && vint(bytes, offset + id.length);
    if (!size) break;
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : dataStart + size.value;
    elements.push({
      id: id.value,
      start: dataStart,
      end: Math.min(end, dataEnd),
      complete: dataEnd <= end,
    });
    if (dataEnd > end || dataEnd <= offset) break;
    offset = dataEnd;
  }
  return elements;
}

export function parseWEBMMetadata(bytes) {
  const uint = (element) => {
    if (!element?.complete || element.end - element.start > 8) return 0;
    let value = 0;
    for (let i = element.start; i < element.end; i++)
      value = value * 256 + bytes[i];
    return Number.isSafeInteger(value) ? value : 0;
  };
  const segment = ebmlElements(bytes, 0, bytes.length).find(
    (element) => element.id === 0x18538067,
  );
  if (!segment) return null;
  const tracks = ebmlElements(bytes, segment.start, segment.end).find(
    (element) => element.id === 0x1654ae6b,
  );
  if (!tracks) return null;
  for (const track of ebmlElements(bytes, tracks.start, tracks.end)) {
    if (track.id !== 0xae) continue;
    const fields = ebmlElements(bytes, track.start, track.end);
    if (uint(fields.find((element) => element.id === 0x83)) !== 1) continue;
    const ns = uint(fields.find((element) => element.id === 0x23e383));
    const fps = 1e9 / ns;
    if (ns && validFPS(fps))
      return { fps, variableFrameRate: false, source: "metadata" };
  }
  return null;
}

export async function readVideoMetadata(file, signal) {
  try {
    const type = file.type || "";
    if (/mp4|quicktime/.test(type) || /\.(mp4|mov|m4v)$/i.test(file.name))
      return await readMP4Metadata(file, signal);
    if (/webm|matroska/.test(type) || /\.(webm|mkv)$/i.test(file.name)) {
      signal?.throwIfAborted();
      const data = await file.slice(0, 1024 * 1024).arrayBuffer();
      signal?.throwIfAborted();
      return parseWEBMMetadata(new Uint8Array(data));
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Malformed, unsupported or oversized metadata must not block playback.
  }
  return null;
}
