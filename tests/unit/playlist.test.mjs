import { test } from "node:test";
import assert from "node:assert/strict";
import { Playlist } from "../../src/media/playlist.js";

function fixture() {
  const revoked = [];
  let id = 0;
  const playlist = new Playlist({
    createObjectURL: () => `blob:${++id}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  return { playlist, revoked };
}
const file = (name) => ({
  name,
  type: "",
  size: 8 * 1024 ** 3,
  arrayBuffer() {
    throw new Error("Must not copy videos into RAM");
  },
});

test("large files and duplicates have independent URLs; ignored files do not change selection", () => {
  const { playlist, revoked } = fixture();
  const source = file("large.mp4");
  assert.equal(playlist.add([source, source, file("notes.txt")]), 2);
  assert.equal(playlist.currentIndex, 1);
  assert.notEqual(playlist.items[0].url, playlist.items[1].url);
  const selected = playlist.current;
  assert.equal(playlist.add([file("notes.txt")]), 0);
  assert.equal(playlist.current, selected);
  playlist.remove(0);
  assert.equal(playlist.current, selected);
  assert.equal(playlist.currentIndex, 0);
  assert.deepEqual(revoked, ["blob:1"]);
  playlist.clear();
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
});
test("selected source is detached before revocation; navigation wraps; removal selects a neighbor", () => {
  const { playlist, revoked } = fixture();
  playlist.add([file("a.mp4"), file("b.mp4"), file("c.mp4")]);
  playlist.navigate(1);
  assert.equal(playlist.current.name, "a.mp4");
  let selectionChanges = 0;
  playlist.addEventListener(
    "change",
    (event) => {
      if (event.detail.selectionChanged) selectionChanges++;
      assert.ok(!revoked.includes("blob:1"));
    },
    { once: true },
  );
  playlist.remove(0);
  assert.equal(selectionChanges, 1);
  assert.equal(playlist.current.name, "b.mp4");
  playlist.select(-1);
  playlist.remove(99);
  assert.equal(playlist.size, 2);
});
