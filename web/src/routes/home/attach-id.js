// One document id per file picked for an item, as the create forms mint one
// per file. The picker is cleared after each try, so a retry is a new File
// object; keying on the item and the file's name, size and lastModified means
// a retry after a lost answer re-sends the same id and the documents route
// hands back the copy it already holds instead of storing a second one.
/** @type {Map<string, string>} */
const ids = new Map();

/** @param {string} itemId @param {File} file */
const keyOf = (itemId, file) => `${itemId}\n${file.name}\n${file.size}\n${file.lastModified}`;

/** @param {string} itemId @param {File} file @returns {string} */
export function attachIdFor(itemId, file) {
  const key = keyOf(itemId, file);
  let id = ids.get(key);
  if (!id) {
    id = crypto.randomUUID();
    ids.set(key, id);
  }
  return id;
}

// The id covers one attempt: once the attach is acknowledged, drop it, so
// removing the paper and picking the same file again sends a fresh id rather
// than one the server now holds against a removed document.
/** @param {string} itemId @param {File} file */
export function forget(itemId, file) {
  ids.delete(keyOf(itemId, file));
}
