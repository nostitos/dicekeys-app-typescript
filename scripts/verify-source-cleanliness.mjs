#!/usr/bin/env node
import { inspectSourceCleanliness } from "./lib/source-cleanliness.mjs";

const allowDirtyEvaluation = process.argv[2] === "--allow-dirty-evaluation";
if (process.argv.length > (allowDirtyEvaluation ? 3 : 2)) {
  throw new Error("verify-source-cleanliness accepts only --allow-dirty-evaluation");
}
const audit = await inspectSourceCleanliness();
if (!audit.clean && !allowDirtyEvaluation) {
  const detail = audit.issues
    .slice(0, 20)
    .map((issue) => `${issue.kind}: ${issue.path}`)
    .join("\n");
  throw new Error(
    `release source is not byte-for-byte clean against HEAD/index (${audit.issues.length} issue(s)):\n${detail}`,
  );
}
console.log(
  audit.clean
    ? `source cleanliness verified across ${audit.indexEntryCount} index entries and working bytes`
    : `dirty evaluation source is fully enumerated across ${audit.indexEntryCount} index entries`,
);
