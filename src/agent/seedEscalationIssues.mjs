// One-time cleanup + seed so each escalate repo has exactly ONE canonical open
// "[Sentinel]" issue. Retitles ledger #1 to the Sentinel format (keeps the #1
// reference valid + makes list-dedup reuse it), closes the test dupes #2/#3,
// and ensures acme-payments has one. Prints the canonical URLs.
const PREFIX = "[Sentinel] Security review required";
const pat = process.env.GITHUB_PAT;
const H = { authorization: `Bearer ${pat}`, accept: "application/vnd.github+json", "user-agent": "sentinel-cockpit" };

const ledgerBody = [
  "Sentinel routed this finding to human review (money-movement path). No code was changed.",
  "",
  "- **jsonwebtoken@8.5.1** (GHSA-8cf7-32gw-wr33) — used on the ledger settlement path; policy requires a human to decide.",
  "  - evidence: `src/ledger/postings.ts:9` · jwt sign/verify for settlement tokens",
  "",
  "_Filed automatically by Sentinel. A human owns the decision._",
].join("\n");

// 1. Retitle ledger #1 to the canonical Sentinel format, keep it open.
let r = await fetch("https://api.github.com/repos/treypeirce/acme-ledger/issues/1", {
  method: "PATCH", headers: H,
  body: JSON.stringify({ title: `${PREFIX}: jsonwebtoken`, body: ledgerBody, state: "open" }),
});
console.log("ledger #1 retitle:", r.status);

// 2. Close the two test dupes.
for (const n of [2, 3]) {
  const c = await fetch(`https://api.github.com/repos/treypeirce/acme-ledger/issues/${n}`, {
    method: "PATCH", headers: H, body: JSON.stringify({ state: "closed" }),
  });
  console.log(`ledger #${n} close:`, c.status);
}

// 3. Ensure acme-payments has exactly one canonical Sentinel issue.
const paymentsBody = [
  "Sentinel routed this finding to human review (money-movement path). No code was changed.",
  "",
  "- **node-forge@1.0.0** (GHSA-5gfm-wpxj-wjgq) — used on the payments charge/refund authorization path; policy requires a human to decide.",
  "  - evidence: `src/payments/tokenSigning.ts` · crypto on the money path",
  "",
  "_Filed automatically by Sentinel. A human owns the decision._",
].join("\n");
let payUrl = null;
const list = await fetch("https://api.github.com/repos/treypeirce/acme-payments/issues?state=open&per_page=50", { headers: H });
if (list.ok) {
  const arr = await list.json();
  const ex = Array.isArray(arr) && arr.find((i) => typeof i?.title === "string" && i.title.startsWith(PREFIX) && !i.pull_request);
  if (ex) payUrl = ex.html_url;
}
if (!payUrl) {
  const c = await fetch("https://api.github.com/repos/treypeirce/acme-payments/issues", {
    method: "POST", headers: H,
    body: JSON.stringify({ title: `${PREFIX}: node-forge`, body: paymentsBody }),
  });
  const d = await c.json();
  payUrl = d?.html_url ?? null;
  console.log("payments create:", c.status);
}
console.log("LEDGER_ISSUE=https://github.com/treypeirce/acme-ledger/issues/1");
console.log("PAYMENTS_ISSUE=" + payUrl);
