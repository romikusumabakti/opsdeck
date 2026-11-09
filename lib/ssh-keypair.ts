import { utils } from "ssh2";

// ssh2's generator now and then (about 1 in 250, measured under Bun and Node)
// emits an ed25519 private key its own parser rejects as malformed; such a key
// could never sign in, and a rotation to it would fail on every server.
const KEYGEN_ATTEMPTS = 20;

/** An ed25519 pair that ssh2 itself can parse. */
export function parseableKeyPair(): { public: string; private: string } {
  for (let attempt = 0; attempt < KEYGEN_ATTEMPTS; attempt++) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error("could not generate a usable ed25519 key");
}
