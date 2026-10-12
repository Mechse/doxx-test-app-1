import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const number = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
export function renderReport(data, dark = false) {
  if (data.schemaVersion !== 1 || !data.cases || !data.kpis) throw new Error('Unsupported baseline schema');
  const fg = dark ? '#eee' : '#17212b', bg = dark ? '#17212b' : '#fff';
  const colors = ['#438bd1', '#b56de2', '#e89732'];
  const frame = (title, inner, height = 360) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img"><title>${escape(title)}</title><rect width="900" height="${height}" fill="${bg}"/><g fill="${fg}" font-family="sans-serif" font-size="12"><text x="24" y="28" font-size="18">${escape(title)}</text>${inner}</g></svg>`;
  const charts = {};
  const table = [];
  const cases = Object.entries(data.cases);
  const targetFor = (name) => data.kpis[{ warm: 'K5', cold: 'K6', load: 'K10', idle: 'K11' }[name]]?.target;
  const max = Math.max(1, ...cases.flatMap(([name, c]) => [c.p99 || 0, targetFor(name) || 0]));
  let bars = colors.map((color, i) => `<text x="${24 + 110 * i}" y="55" fill="${color}">${['p50', 'p95', 'p99'][i]} (ms)</text>`).join('');
  cases.forEach(([name, c], index) => {
    const x = 45 + index * (800 / cases.length), width = Math.min(18, 200 / cases.length);
    ['p50', 'p95', 'p99'].forEach((p, i) => { const h = (c[p] || 0) / max * 220; bars += `<rect x="${x + i * width}" y="${290 - h}" width="${width - 2}" height="${h}" fill="${colors[i]}"/>`; });
    const target = targetFor(name);
    if (Number.isFinite(target)) { const y = 290 - target / max * 220; bars += `<path d="M${x - 3} ${y}h${width * 3 + 4}" stroke="${fg}" stroke-dasharray="4 2"/><text x="${x}" y="${y - 5}">${number(target)}</text>`; }
    bars += `<text x="${x}" y="312">${escape(name)}</text>`;
    table.push(`| ${name} | ${c.count} | ${number(c.p50)} | ${number(c.p95)} | ${number(c.p99)} | ${number(target)} |`);
  });
  charts['latency-percentiles'] = frame('Request and TCP percentiles · dashed marks: request targets', bars);
  const breakdown = cases.filter(([, c]) => c.breakdown);
  let stacks = '<text x="24" y="55">p50 components (ms): network residual / app / database</text>';
  const stackMax = Math.max(1, ...breakdown.map(([, c]) => ['network', 'app', 'db'].reduce((sum, k) => sum + c.breakdown[k].p50, 0)));
  const breakdownRows = [];
  breakdown.forEach(([name, c], index) => {
    let x = 120; const y = 80 + index * 45;
    stacks += `<text x="24" y="${y + 18}">${escape(name)}</text>`;
    ['network', 'app', 'db'].forEach((key, i) => { const width = c.breakdown[key].p50 / stackMax * 700; stacks += `<rect x="${x}" y="${y}" width="${width}" height="24" fill="${colors[i]}"/>`; x += width; });
    breakdownRows.push(`| ${name} | ${number(c.breakdown.network.p50)} | ${number(c.breakdown.app.p50)} | ${number(c.breakdown.db.p50)} |`);
  });
  charts['latency-breakdown'] = frame('Server timing breakdown · component medians are approximate', stacks, Math.max(240, 100 + 45 * breakdown.length));
  const tcp = data.cases.tcp?.samples || [], direct = data.cases.direct?.samples || [];
  const top = Math.max(1, ...tcp, ...direct); const bins = 12;
  const histogram = (values) => { const counts = Array(bins).fill(0); values.forEach((v) => counts[Math.min(bins - 1, Math.floor(v / top * bins))]++); return counts; };
  const hist = [histogram(tcp), histogram(direct)]; const countMax = Math.max(1, ...hist.flat());
  let histSvg = '<text x="24" y="55">Blue: tunnel TCP · Purple: regional AWS API TCP (not a controlled direct path)</text>';
  const histRows = [];
  for (let i = 0; i < bins; i++) {
    hist.forEach((counts, j) => { const height = counts[i] / countMax * 220; histSvg += `<rect x="${45 + i * 66 + j * 24}" y="${290 - height}" width="22" height="${height}" fill="${colors[j]}"/>`; });
    histSvg += `<text x="${45 + i * 66}" y="312">${number(i * top / bins)}</text>`;
    histRows.push(`| ${number(i * top / bins)}–${number((i + 1) * top / bins)} | ${hist[0][i]} | ${hist[1][i]} |`);
  }
  charts['rtt-distribution'] = frame('TCP timing distribution · lower bin edge in ms', histSvg);
  const timeline = data.timeline || []; const peak = Math.max(1, ...timeline.map((r) => r.p95)); const duration = Math.max(1, ...timeline.map((r) => r.second));
  const points = timeline.map((r) => `${45 + r.second / duration * 800},${290 - r.p95 / peak * 220}`).join(' ');
  charts['load-timeline'] = frame(`Load p95 per second · scale 0–${number(peak)} ms`, `<polyline points="${points}" fill="none" stroke="${colors[0]}" stroke-width="3"/><text x="45" y="315">0 seconds</text><text x="780" y="315">${duration} seconds</text>`);
  const picture = (name, alt) => `<picture><source media="(prefers-color-scheme: dark)" srcset="docs/img/${name}-dark.svg"><img src="docs/img/${name}-light.svg" alt="${alt}"></picture>`;
  const markdown = [
    `Run: ${escape(data.timestamp)} · ${escape(data.transport)} · ${escape(data.region)}. Thresholds provisional: ${data.provisional ? 'yes' : 'no'}.`,
    '| KPI | Measured | Target | Result |\n|---|---:|---:|---|\n' + Object.entries(data.kpis).map(([k, v]) => `| ${k} | ${number(v.measured)} | ${number(v.target)} | ${v.pass ? 'PASS' : 'FAIL'} |`).join('\n'),
    picture('latency-percentiles', 'Latency percentiles and applicable request targets'),
    '| Case | Samples | p50 ms | p95 ms | p99 ms | Target ms |\n|---|---:|---:|---:|---:|---:|\n' + table.join('\n'),
    picture('latency-breakdown', 'Median network residual, application, and database durations'),
    '| Route | Network ms | App ms | DB ms |\n|---|---:|---:|---:|\n' + breakdownRows.join('\n'),
    picture('rtt-distribution', 'Histogram comparing tunnel and regional endpoint TCP connection times'),
    '| Bin ms | Tunnel count | Regional count |\n|---|---:|---:|\n' + histRows.join('\n'),
    picture('load-timeline', 'Request p95 per second under concurrent load'),
    '| Second | Samples | p95 ms |\n|---|---:|---:|\n' + timeline.map((r) => `| ${r.second} | ${r.count} | ${number(r.p95)} |`).join('\n')
  ].join('\n\n');
  return { charts, markdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = JSON.parse(await readFile('results/baseline.json', 'utf8'));
  const readme = await readFile('README.md', 'utf8');
  if (!readme.includes('<!-- latency:start -->') || !readme.includes('<!-- latency:end -->')) throw new Error('README latency markers missing');
  await mkdir('docs/img', { recursive: true });
  for (const dark of [false, true]) {
    const { charts } = renderReport(data, dark);
    for (const [name, svg] of Object.entries(charts)) await writeFile(`docs/img/${name}-${dark ? 'dark' : 'light'}.svg`, svg);
  }
  await writeFile('README.md', readme.replace(/<!-- latency:start -->[\s\S]*?<!-- latency:end -->/, `<!-- latency:start -->\n\n${renderReport(data).markdown}\n\n<!-- latency:end -->`));
}
