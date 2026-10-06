import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readMP4Metadata,
  readVideoMetadata,
  parseWEBMMetadata,
} from "../../src/media/metadata.js";

const uint = (n) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(n);
  return buffer;
};
const box = (type, ...parts) => {
  const data = Buffer.concat(parts);
  return Buffer.concat([uint(data.length + 8), Buffer.from(type), data]);
};
function moov({ version = 0, timescale = 30000, entries = [[90, 1001]] } = {}) {
  const header = Buffer.alloc(version ? 36 : 24);
  header[0] = version;
  header.writeUInt32BE(timescale, version ? 20 : 12);
  return box(
    "moov",
    box(
      "trak",
      box(
        "mdia",
        box("hdlr", Buffer.alloc(8), Buffer.from("vide"), Buffer.alloc(8)),
        box("mdhd", header),
        box(
          "minf",
          box(
            "stbl",
            box(
              "stts",
              Buffer.alloc(4),
              uint(entries.length),
              ...entries.flatMap(([n, delta]) => [uint(n), uint(delta)]),
            ),
          ),
        ),
      ),
    ),
  );
}

test("MP4 skips a 3 GB mdat and reads a moov at the end without reading media", async () => {
  const prefix = Buffer.concat([
    box("ftyp", Buffer.from("isom0000")),
    uint(3 * 1024 ** 3),
    Buffer.from("mdat"),
  ]);
  const suffix = moov();
  const suffixStart = prefix.length - 8 + 3 * 1024 ** 3;
  let readBytes = 0;
  const sparse = {
    size: suffixStart + suffix.length,
    slice(start, end) {
      readBytes += end - start;
      let data;
      if (end <= prefix.length) data = prefix.subarray(start, end);
      else if (start >= suffixStart)
        data = suffix.subarray(start - suffixStart, end - suffixStart);
      else throw new Error("Attempted to read media payload");
      return new Blob([data]);
    },
  };
  const result = await readMP4Metadata(sparse);
  assert.ok(Math.abs(result.fps - 30000 / 1001) < 0.0001);
  assert.equal(result.variableFrameRate, false);
  assert.ok(readBytes < 2048, `Read ${readBytes} bytes`);
});
test("version 1 timing, variable FPS, MIME-less files and fragmented files", async () => {
  const file = new Blob([
    moov({
      version: 1,
      timescale: 1000,
      entries: [
        [10, 40],
        [10, 80],
      ],
    }),
  ]);
  file.name = "clip.MOV";
  const result = await readVideoMetadata(file);
  assert.equal(result.variableFrameRate, true);
  assert.ok(Math.abs(result.fps - 20 / 1.2) < 0.0001);
  assert.equal(await readMP4Metadata(new Blob([moov({ entries: [] })])), null);
});
test("malformed and over-budget metadata do not prevent playback; cancellation is propagated", async () => {
  const file = new Blob([uint(5), Buffer.from("moov")]);
  file.name = "bad.mp4";
  assert.equal(await readVideoMetadata(file), null);
  const huge = new Blob([moov({ entries: [[1, 0]] })]);
  huge.name = "bad.mp4";
  assert.equal(await readVideoMetadata(huge), null);
  const oversized = new Blob([
    box(
      "moov",
      box(
        "trak",
        box(
          "mdia",
          box("hdlr", Buffer.alloc(8), Buffer.from("vide")),
          box(
            "mdhd",
            Buffer.concat([Buffer.alloc(12), uint(30000), Buffer.alloc(8)]),
          ),
          box(
            "minf",
            box(
              "stbl",
              box(
                "stts",
                Buffer.alloc(4),
                uint(600000),
                Buffer.alloc(600000 * 8),
              ),
            ),
          ),
        ),
      ),
    ),
  ]);
  oversized.name = "oversized.mp4";
  assert.equal(await readVideoMetadata(oversized), null);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readVideoMetadata(file, abort.signal), {
    name: "AbortError",
  });
});

const ebml = (id, data) =>
  Buffer.concat([
    Buffer.from(id, "hex"),
    Buffer.from([128 + data.length]),
    data,
  ]);
const track = (type, duration) =>
  ebml(
    "ae",
    Buffer.concat([
      ebml("83", Buffer.from([type])),
      ebml("23e383", uint(duration)),
    ]),
  );
test("WebM chooses the video track and supports nanosecond durations beyond signed 32-bit range", () => {
  const tracks = ebml(
    "1654ae6b",
    Buffer.concat([track(2, 20_000_000), track(1, 3_000_000_000)]),
  );
  const segment = Buffer.concat([Buffer.from("18538067ff", "hex"), tracks]);
  const result = parseWEBMMetadata(segment);
  assert.equal(result.fps, 1 / 3);
  assert.equal(parseWEBMMetadata(Buffer.from([0, 255, 0])), null);
  assert.equal(
    parseWEBMMetadata(
      Buffer.concat([
        Buffer.from("18538067ff", "hex"),
        ebml("1654ae6b", track(2, 20_000_000)),
      ]),
    ),
    null,
  );
});
