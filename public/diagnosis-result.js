const sectionNames = new Map([
  ['am wahrscheinlichsten', 'cause'], ['wie sicher', 'confidence'],
  ['verbindungsabschnitte', 'path'], ['warum', 'evidence'],
  ['was jetzt', 'next'], ['was bleibt offen', 'uncertainty'], ['andere möglichkeiten', 'alternatives'],
]);
const clean = value => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
const heading = line => line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/)?.[1] || line.match(/^\*\*([^*]+)\*\*:?$/)?.[1];
const normalized = value => clean(value).toLocaleLowerCase('de-DE').replace(/[?:]+$/, '').trim();

// Old archive entries remain readable without changing their saved answer or
// inventing a new diagnosis from a few keywords in that answer.
export function parseDiagnosisResult(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
  const sections = {};
  let current = null;
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const title = heading(line.trim());
    if (title) {
      current = sectionNames.get(normalized(title)) || null;
      if (current) sections[current] ??= '';
    } else if (current) sections[current] += `${line}\n`;
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].trim();
  const structured = Boolean(sections.cause);
  const firstParagraph = raw.trim().split(/\r?\n\s*\r?\n/).find(part => part.trim() && !/^#{1,6}\s+[^\n]+$/.test(part.trim())) || raw;
  const confidence = structured ? clean(sections.confidence || '').match(/^(?:Sicherheit\s*:\s*)?(Niedrig|Mittel|Hoch|Noch offen)\b/i)?.[1] || null : null;
  return { raw, structured, sections, confidence, lead: structured ? sections.cause : firstParagraph.trim() };
}

// All model output is text, including anything resembling HTML or a URL.
function inline(parent, source) {
  const doc = parent.ownerDocument;
  let offset = 0;
  for (const match of source.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)) {
    parent.append(doc.createTextNode(source.slice(offset, match.index)));
    const node = doc.createElement(match[1] ? 'strong' : 'code');
    node.textContent = match[1] || match[2]; parent.append(node);
    offset = match.index + match[0].length;
  }
  parent.append(doc.createTextNode(source.slice(offset)));
}

function formatted(parent, source) {
  const doc = parent.ownerDocument;
  let paragraph = [], list = null;
  const flush = () => {
    if (!paragraph.length) return;
    const node = doc.createElement('p'); inline(node, paragraph.join(' ')); parent.append(node); paragraph = [];
  };
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim(), title = heading(trimmed);
    const bullet = trimmed.match(/^(?:([-*])\s+|(\d+)[.)]\s+)(.+)$/);
    if (!trimmed) { flush(); list = null; }
    else if (title) { flush(); list = null; const node = doc.createElement('h5'); inline(node, title); parent.append(node); }
    else if (bullet) {
      flush(); const tag = bullet[1] ? 'ul' : 'ol';
      if (list?.tagName.toLowerCase() !== tag) {
        list = doc.createElement(tag);
        if (tag === 'ol') list.start = Number(bullet[2]);
        parent.append(list);
      }
      const item = doc.createElement('li'); inline(item, bullet[3]); list.append(item);
    } else if (list) { const item = list.lastElementChild; item.append(doc.createTextNode(' ')); inline(item, trimmed); }
    else paragraph.push(trimmed);
  }
  flush();
}

const rendered = new WeakMap();
export function renderDiagnosisResult(root, value) {
  const result = parseDiagnosisResult(value);
  if (rendered.get(root) === result.raw && root.childNodes.length) return;
  const doc = root.ownerDocument;
  const node = (tag, className, text) => { const el = doc.createElement(tag); el.className = className; if (text) el.textContent = text; return el; };
  root.replaceChildren();
  root.classList.add('ai-diagnosis');
  const lead = node('section', 'ai-diagnosis-lead');
  lead.append(node('p', 'ai-diagnosis-eyebrow', result.structured ? 'AM WAHRSCHEINLICHSTEN' : 'BISHERIGER BEFUND'));
  const title = node('div', 'ai-diagnosis-cause'); formatted(title, result.lead); lead.append(title);
  if (result.sections.confidence && result.structured) {
    const confidence = node('div', 'ai-diagnosis-confidence');
    confidence.append(node('strong', '', 'Wie sicher? ')); inline(confidence, result.sections.confidence); lead.append(confidence);
  }
  root.append(lead);
  if (result.structured) {
    if (result.sections.path) {
      const path = node('section', 'ai-diagnosis-path');
      path.append(node('h4', '', 'Wo hängt es?'));
      const entries = result.sections.path.split(/\n(?=\s*[-*]\s+)/).map(text => text.trim().replace(/^[-*]\s+/, '')).filter(Boolean);
      for (const entry of entries) {
        const row = node('div', 'ai-diagnosis-segment');
        // Only explicit assessment labels after the section name control color.
        const label = clean(entry).match(/:\s*(Verdächtig|Eher unauffällig|Unklar)\b/i)?.[1];
        row.dataset.assessment = label?.toLocaleLowerCase('de-DE') === 'verdächtig' ? 'suspect' : label?.toLocaleLowerCase('de-DE') === 'eher unauffällig' ? 'clear' : 'unknown';
        inline(row, entry); path.append(row);
      }
      root.append(path);
    }
    const grid = node('div', 'ai-diagnosis-grid');
    for (const [key, title] of [['evidence', 'Warum?'], ['next', 'Was soll ich jetzt tun?']]) {
      if (!result.sections[key]) continue;
      const card = node('section', `ai-diagnosis-card ai-diagnosis-${key}`);
      card.append(node('h4', '', title)); formatted(card, result.sections[key]); grid.append(card);
    }
    root.append(grid);
    if (result.sections.uncertainty) {
      const open = node('div', 'ai-diagnosis-uncertainty');
      open.append(node('strong', '', 'Noch unklar: ')); inline(open, result.sections.uncertainty); root.append(open);
    }
  } else {
    root.append(node('p', 'ai-diagnosis-legacy-note', 'Gespeicherte Antwort im bisherigen Format. Eine neue Auswertung erklärt Ursache und nächsten Schritt einfacher.'));
  }
  const details = node('details', 'ai-diagnosis-details');
  details.append(node('summary', '', 'Vollständige Antwort lesen'));
  const body = node('div', 'ai-diagnosis-full'); formatted(body, result.raw); details.append(body); root.append(details);
  rendered.set(root, result.raw);
}
