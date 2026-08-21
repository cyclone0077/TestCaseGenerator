/* ==========================================================================
   dnsOverride.js — forces ALL DNS resolution (not just SRV/TXT lookups)
   through DNS_SERVERS when set, for mongodb+srv:// connections that fail
   against a network's default resolver (VPN / corporate DNS interference).

   Ported from the reference Compliance Coverage Agent's config/env.ts:
   dns.setServers() alone only redirects dns.resolve*() (the SRV/TXT lookup
   that discovers a replica set's member hostnames) - the actual TCP/TLS
   connection to each discovered hostname still goes through dns.lookup(),
   which keeps using the OS/VPN resolver unless patched too. Confirmed
   necessary the hard way: create-testplan-embeddings.js's simpler
   dns.setServers()-only override was NOT enough to connect to the
   Compliance cluster from an org VPN that returns different results for
   dns.lookup() than for dns.resolve4() - raw MongoClient connections
   failed with a TLS "internal error" alert until this full patch was
   applied, even though the exact same URI connected fine once nodemon/
   ts-node loaded config/env.ts's equivalent patch in the reference project.

   ponytail: IPv4-only, no caching, falls back to the original lookup if
   resolve4() fails for a given hostname. Upgrade path: a dns.Resolver
   instance with a custom lookup passed per-connection instead of a
   process-wide monkey-patch, if that specificity is ever needed.
   ========================================================================== */

const dns = require("dns");

let applied = false;

function applyDnsOverride() {
  if (applied) return;
  applied = true;

  const dnsServers = (process.env.DNS_SERVERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length === 0) return;

  dns.setServers(dnsServers);

  const originalLookup = dns.lookup;
  const resolve4 = dns.promises.resolve4.bind(dns.promises);
  dns.lookup = (hostname, ...args) => {
    const callback = args[args.length - 1];
    const options = args.length > 1 ? args[0] : undefined;
    const wantAll = typeof options === "object" && options !== null && options.all;

    resolve4(hostname)
      .then((addresses) => {
        if (!addresses.length) throw new Error("no A records");
        if (wantAll) callback(null, addresses.map((address) => ({ address, family: 4 })));
        else callback(null, addresses[0], 4);
      })
      .catch(() => originalLookup(hostname, ...args));
  };
}

module.exports = { applyDnsOverride };
