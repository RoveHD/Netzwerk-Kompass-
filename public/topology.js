// Pure layout: only links explicitly reported by the router connect nodes.
export function buildTopology(mesh = {}) {
  const sourceNodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
  const sourceLinks = Array.isArray(mesh?.links) ? mesh.links : [];
  const byId = new Map();
  for (const item of sourceNodes.slice(0, 256)) if (item && typeof item.id === 'string' && item.id && !byId.has(item.id)) byId.set(item.id, { ...item });
  const nodes = [...byId.values()]; const links = []; const dangling = []; const seen = new Set();
  for (const [index, item] of sourceLinks.slice(0, 1024).entries()) {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
    const id = typeof item.id === 'string' && item.id ? item.id : `legacy-${index}`;
    if (seen.has(id)) continue; seen.add(id);
    const link = { ...item, id };
    if (!byId.has(link.from) || !byId.has(link.to)) dangling.push(link); else links.push(link);
  }
  const neighbors = new Map(nodes.map(item => [item.id, new Set()]));
  for (const link of links) if (link.state !== 'DISCONNECTED') { neighbors.get(link.from).add(link.to); neighbors.get(link.to).add(link.from); }
  const pending = new Set(byId.keys()); const components = []; let top = 36; let maxDepth = 0;
  const ordered = nodes.slice().sort((a, b) => Number(b.role === 'MASTER') - Number(a.role === 'MASTER') || neighbors.get(b.id).size - neighbors.get(a.id).size || a.id.localeCompare(b.id));
  for (const root of ordered) {
    if (!pending.has(root.id)) continue;
    const component = []; const queue = [{ id: root.id, depth: 0 }]; pending.delete(root.id);
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]; component.push(entry);
      for (const id of neighbors.get(entry.id)) if (pending.delete(id)) queue.push({ id, depth: entry.depth + 1 });
    }
    const rows = new Map();
    for (const entry of component) {
      const row = rows.get(entry.depth) || 0; rows.set(entry.depth, row + 1);
      Object.assign(byId.get(entry.id), { x: 36 + entry.depth * 420, y: top + row * 126, component: components.length });
      maxDepth = Math.max(maxDepth, entry.depth);
    }
    top += Math.max(...rows.values()) * 126 + 32; components.push(component.map(entry => entry.id));
  }
  return { nodes, links, dangling, components, width: Math.max(640, 420 * maxDepth + 300), height: Math.max(230, top), byId };
}

const element = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = String(text); return item; };
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s` : null;
const typeLabel = type => ({ LAN: 'LAN / Kabel', Ethernet: 'LAN / Kabel', WLAN: 'WLAN', PLC: 'Powerline', DECT: 'DECT' })[type] || 'Verbindungstyp unbekannt';
const roleLabel = item => item.role === 'MASTER' ? 'Mesh-Master' : item.role === 'SLAVE' ? (/repeater/i.test(item.model || '') ? 'Mesh-Repeater' : 'Mesh-Gerät') : 'Gerät';
function domKey(value) { let hash = 2166136261; for (const char of String(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619); return (hash >>> 0).toString(16); }

export function renderTopology(parent, mesh, state = {}, prefix = 'live') {
  const graph = buildTopology(mesh); const wrapper = element('div', 'mesh-topology');
  wrapper.append(element('p', 'mesh-topology-note', 'Gemeldete Verbindungen · Knoten auswählen für Details. Linkraten beschreiben die lokale Verbindung.'));
  if (mesh?.truncated) wrapper.append(element('p', 'mesh-topology-note', `Begrenzter Snapshot: ${graph.nodes.length} von ${mesh.totalNodes ?? '?'} Knoten gespeichert.`));
  if (!graph.nodes.length) { wrapper.append(element('p', 'fritzbox-empty', 'Keine Topologie von der Box gemeldet.')); parent.append(wrapper); return; }
  const summary = `${graph.nodes.length} Knoten · ${graph.links.filter(link => link.state !== 'DISCONNECTED').length} aktive Verbindungen · ${graph.components.length} getrennte Gruppen`;
  wrapper.append(element('p', 'mesh-topology-summary', summary));
  if (graph.dangling.length) wrapper.append(element('p', 'mesh-topology-note', `${graph.dangling.length} gemeldete Verbindungen haben einen nicht enthaltenen Endpunkt und werden nicht eingezeichnet.`));
  const scroll = element('div', 'mesh-topology-scroll'); scroll.setAttribute('aria-label', 'Mesh-Topologie, bei Bedarf horizontal und vertikal scrollen'); scroll.tabIndex = 0;
  const canvas = element('div', 'mesh-topology-canvas'); canvas.style.width = `${graph.width}px`; canvas.style.height = `${graph.height}px`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', graph.width); svg.setAttribute('height', graph.height); svg.setAttribute('aria-hidden', 'true');
  const svgElement = (tag, attrs, text) => { const item = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value); if (text != null) item.textContent = String(text); svg.append(item); return item; };
  const parallel = new Map();
  graph.links.forEach(link => { const key = JSON.stringify([link.from, link.to].sort()); const list = parallel.get(key) || []; list.push(link); parallel.set(key, list); });
  for (const link of graph.links) {
    const from = graph.byId.get(link.from), to = graph.byId.get(link.to); const group = parallel.get(JSON.stringify([link.from, link.to].sort()));
    const offset = (group.indexOf(link) - (group.length - 1) / 2) * 34;
    const x1 = from.x + 110, y1 = from.y + 45, x2 = to.x + 110, y2 = to.y + 45;
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2 + offset;
    const path = link.from === link.to ? `M ${x1} ${y1} C ${x1 + 165} ${y1 - 110} ${x1 + 165} ${y1 + 110} ${x1} ${y1}` : `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
    const line = svgElement('path', { d: path, class: `mesh-link${link.type === 'WLAN' ? ' mesh-link-wlan' : ''}${link.state === 'DISCONNECTED' ? ' mesh-link-disconnected' : ''}` });
    const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${from.name || from.id} ↔ ${to.name || to.id} · ${typeLabel(link.type)}${link.state === 'DISCONNECTED' ? ' · getrennt' : ''}`; line.append(title);
    svgElement('text', { x: midX, y: midY - 11, 'text-anchor': 'middle', class: 'mesh-link-label' }, `${typeLabel(link.type)}${link.state === 'DISCONNECTED' ? ' · getrennt' : ''}`);
    const rates = [rate(link.receiveRateMbps ?? link.rateMbps), rate(link.transmitRateMbps)];
    if (rates.some(Boolean) && link.state !== 'DISCONNECTED') {
      svgElement('text', { x: midX, y: midY + 17, 'text-anchor': 'middle', class: 'mesh-link-rate' }, `RX ${rates[0] || '–'}`);
      svgElement('text', { x: midX, y: midY + 31, 'text-anchor': 'middle', class: 'mesh-link-rate' }, `TX ${rates[1] || '–'}`);
    }
  }
  canvas.append(svg); const buttons = new Map(); const detail = element('div', 'mesh-topology-detail');
  const showSelection = id => {
    state.selectedId = id; const selected = graph.byId.get(id); if (!selected) return;
    state.selectedMac = selected.mac?.toUpperCase() || null;
    for (const [nodeId, button] of buttons) { button.classList.toggle('is-selected', nodeId === id); button.setAttribute('aria-pressed', String(nodeId === id)); }
    detail.replaceChildren(element('h4', '', selected.name || 'Unbenanntes Gerät'));
    detail.append(element('p', '', [roleLabel(selected), selected.model, selected.ip].filter(Boolean).join(' · ')));
    const connections = graph.links.filter(link => link.from === id || link.to === id);
    if (!connections.length) detail.append(element('p', 'mesh-topology-note', 'Keine Verbindung für diesen Knoten gemeldet.'));
    for (const link of connections) {
      const other = graph.byId.get(link.from === id ? link.to : link.from);
      const from = graph.byId.get(link.from), to = graph.byId.get(link.to);
      const text = `${from.name || from.id} → ${to.name || to.id} · ${typeLabel(link.type)} · ${link.state === 'DISCONNECTED' ? 'getrennt' : 'verbunden'} · RX (zu ${from.name || from.id}): ${rate(link.receiveRateMbps ?? link.rateMbps) || '–'} · TX (zu ${to.name || to.id}): ${rate(link.transmitRateMbps) || '–'}`;
      detail.append(element('p', 'mesh-topology-connection', text));
    }
  };
  for (const item of graph.nodes) {
    const button = element('button', `mesh-node${item.role === 'MASTER' ? ' mesh-node-master' : ''}`); button.type = 'button'; button.id = `mesh-${prefix}-${domKey(item.id)}`;
    button.style.left = `${item.x}px`; button.style.top = `${item.y}px`; button.title = [item.name || item.id, item.model, item.ip].filter(Boolean).join(' · ');
    button.append(element('span', 'mesh-node-role', roleLabel(item)), element('strong', '', item.name || 'Unbenanntes Gerät'), element('span', 'mesh-node-address', item.ip || item.model || 'IP unbekannt'));
    button.addEventListener('click', () => showSelection(item.id)); buttons.set(item.id, button); canvas.append(button);
  }
  scroll.append(canvas); scroll.addEventListener('scroll', () => { state.scrollLeft = scroll.scrollLeft; state.scrollTop = scroll.scrollTop; }); wrapper.append(scroll, detail); parent.append(wrapper);
  scroll.scrollLeft = state.scrollLeft || 0; scroll.scrollTop = state.scrollTop || 0;
  const byMac=state.selectedMac&&graph.nodes.find(item=>item.mac?.toUpperCase()===state.selectedMac);
  showSelection(byMac?.id || (!state.selectedMac&&graph.byId.has(state.selectedId)?state.selectedId:null) || graph.nodes.find(item => item.role === 'MASTER')?.id || graph.nodes[0].id);
}
