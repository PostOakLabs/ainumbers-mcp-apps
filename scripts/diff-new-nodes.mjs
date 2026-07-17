// Prints a comma-separated list of mcp_names for live nodes newly added to
// chaingraph.json in the current push (vs the parent commit). Used by CI to feed
// hash-sweep.mjs a dedicated post-propagation verify list for just-vendored nodes,
// instead of relying on the random 40-sample to happen to catch them.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REL_PATH = 'data/chaingraph/chaingraph.json';
const CHAINGRAPH = process.env.CHAINGRAPH || join(HERE, '..', REL_PATH);

function liveNames(jsonText){
  const cg = JSON.parse(jsonText);
  return new Set((cg.nodes||[]).filter((n)=>n.status==='live' && n.mcp_name).map((n)=>n.mcp_name));
}

let oldNames = new Set();
try {
  const oldJson = execSync('git show HEAD^:' + REL_PATH, { encoding:'utf8', stdio:['pipe','pipe','ignore'], maxBuffer: 64*1024*1024 });
  oldNames = liveNames(oldJson);
} catch (e) {
  // No parent commit reachable (shallow checkout or first commit) - treat as empty,
  // which means every live node looks "new". Caller should ensure fetch-depth >= 2.
  console.error('diff-new-nodes: could not read HEAD^ chaingraph.json (' + e.message + ') - treating all live nodes as new');
}

const newNames = liveNames(readFileSync(CHAINGRAPH, 'utf8'));
const added = [...newNames].filter((n)=>!oldNames.has(n));
process.stdout.write(added.join(','));
