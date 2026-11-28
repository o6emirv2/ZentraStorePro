"use strict";
const { getAvatarById } = require("../core/storeAvatars");

function publicProfile(row) {
  const candidates = [row?.username, row?.storeProfile?.username, row?.usernameLower];
  const username = candidates
    .map((name) => (typeof name === "string" ? name.trim().normalize("NFC") : ""))
    .find((name) => /^[\p{L}\p{N}._-]{1,40}$/u.test(name));
  if (!username || row?.storeAccountStatus === "suspended")
    return { kind: "unavailable", username: "", avatarUrl: "" };
  const avatar = getAvatarById(row.storeProfile?.avatarId || row.storeAvatarId || "1");
  return { kind: "member", username, avatarUrl: avatar?.image || "" };
}

async function memberProfile(db, uid, row, read = (ref) => ref.get()) {
  const profile = publicProfile(row);
  if (
    profile.username ||
    !row ||
    !Object.keys(row).length ||
    row.storeAccountStatus === "suspended"
  )
    return profile;
  // Some older registrations only stored the public handle in the username registry.
  const matches = await read(db.collection("usernameRegistry").where("uid", "==", uid).limit(5));
  const names = new Set(
    matches.docs
      .map((doc) => publicProfile({ username: doc.data().username }).username)
      .filter(Boolean),
  );
  return names.size === 1 ? publicProfile({ ...row, username: [...names][0] }) : profile;
}

async function readPublicProfiles(database, values) {
  const uids = [
    ...new Set(
      values.filter(
        (uid) =>
          typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !uid.includes("/"),
      ),
    ),
  ];
  const result = new Map();
  for (let start = 0; start < uids.length; start += 50) {
    const refs = uids.slice(start, start + 50).map((uid) => database.collection("users").doc(uid));
    const docs = await database.getAll(...refs);
    await Promise.all(
      docs.map(async (doc) =>
        result.set(doc.id, await memberProfile(database, doc.id, doc.data())),
      ),
    );
  }
  return result;
}

const unavailableProfile = () => publicProfile(null);
module.exports = { memberProfile, publicProfile, readPublicProfiles, unavailableProfile };
