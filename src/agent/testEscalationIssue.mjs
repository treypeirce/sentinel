// Validates the exact ensureEscalationIssue logic from server.ts against a real
// repo, using GITHUB_PAT. Run twice to prove dedup (create once, then reuse).
const ESC_TITLE_PREFIX = "[Sentinel] Security review required";
const ISSUE_CACHE = {};

async function ensureEscalationIssue(repoUrl, findings) {
  if (ISSUE_CACHE[repoUrl]) return { url: ISSUE_CACHE[repoUrl], why: "reused from memory" };
  const pat = process.env.GITHUB_PAT;
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!pat || !m) return { url: null, why: "no pat or bad url" };
  const owner = m[1], repo = m[2];
  const headers = { authorization: `Bearer ${pat}`, accept: "application/vnd.github+json", "user-agent": "sentinel-cockpit" };
  const list = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=50`, { headers });
  if (list.ok) {
    const arr = await list.json();
    const existing = Array.isArray(arr) && arr.find((i) => typeof i?.title === "string" && i.title.startsWith(ESC_TITLE_PREFIX) && !i.pull_request);
    if (existing) { ISSUE_CACHE[repoUrl] = existing.html_url; return { url: existing.html_url, why: "reused existing (list)" }; }
  }
  const esc = findings.filter((f) => f.verdict === "ESCALATE");
  const lines = [
    "Sentinel routed the following finding(s) to human review (money-movement path, or the investigation was inconclusive). No code was changed.",
    "",
    ...esc.map((f) => `- **${f.package}${f.version ? "@" + f.version : ""}** (${f.cve ?? "advisory"}) — ${f.reason}`),
  ];
  for (const f of esc) for (const e of (f.evidence ?? [])) lines.push(`  - evidence: \`${e.file}${e.line ? ":" + e.line : ""}\`${e.note ? " · " + e.note : ""}`);
  lines.push("", "_Filed automatically by Sentinel. A human owns the decision._");
  const create = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST", headers,
    body: JSON.stringify({ title: `${ESC_TITLE_PREFIX}: ${esc[0]?.package ?? "dependency"}`, body: lines.join("\n") }),
  });
  if (!create.ok) return { url: null, why: "create failed " + create.status };
  const d = await create.json();
  if (d?.html_url) ISSUE_CACHE[repoUrl] = d.html_url;
  return { url: d?.html_url ?? null, why: "created new" };
}

const findings = [{ package: "jsonwebtoken", version: "8.5.1", cve: "GHSA-8cf7-32gw-wr33", verdict: "ESCALATE", evidence: [{ file: "src/ledger/postings.ts", line: 9, note: "settlement token sign/verify" }], reason: "Used on the ledger money-movement path; policy requires human review." }];

const r1 = await ensureEscalationIssue("https://github.com/treypeirce/acme-ledger", findings);
console.log("RUN 1:", JSON.stringify(r1));
const r2 = await ensureEscalationIssue("https://github.com/treypeirce/acme-ledger", findings);
console.log("RUN 2:", JSON.stringify(r2));
console.log(r1.url && r2.url && r1.url === r2.url ? "DEDUP OK · same issue both runs" : "DEDUP FAIL");
