import { readdir, readFile } from 'node:fs/promises';
const skip = new Set(['.git', '.terraform', '.local', 'node_modules', 'results']);
const candidates = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && (path.endsWith('.example') || !/\.env(?:\..+)?$|\.tfvars(?:\.json)?$|\.tfstate(?:\..+)?$|\.tfplan$/.test(path))) candidates.push(path);
  }
}
await walk('.');
// This is a local safeguard, not a substitute for inspecting the staged diff.
const token = process.env.DOXX_TOKEN;
let bad = false;
for (const path of candidates) {
  const text = await readFile(path, 'utf8');
  if ((token && token.length > 8 && text.includes(token)) || /AKIA[0-9A-Z]{16}|PrivateKey\s*=\s*[A-Za-z0-9+/]{43}=|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    console.error(`Potential secret in ${path} (value suppressed)`); bad = true;
  }
}
if (bad) process.exitCode = 1;
else console.log('Source secret-pattern scan passed. Review staged files and any baseline manually before publishing.');
