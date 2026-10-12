import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnosisResult } from '../public/diagnosis-result.js';

const answer=`## Am wahrscheinlichsten
Die Verbindung vom Router ins Internet macht Probleme.

## Wie sicher?
Mittel – der genaue Verursacher steht noch nicht fest.

## Verbindungsabschnitte
- **PC → Repeater (Kabel):** Eher unauffällig – antwortet zuverlässig.
- **Repeater → Router (WLAN):** Eher unauffällig – Router antwortet ebenfalls.
- **Router → Internet:** Verdächtig – beide Internetziele fallen gleichzeitig auf.

## Warum?
- Der Router antwortet schnell.
- Beide Internetziele antworten zeitweise nicht.

## Was jetzt?
Vergleiche während einer Störung mit einem zweiten Gerät direkt am Router.
- Hat es dasselbe Problem, spricht das für die Internetverbindung.
- Läuft es gut, prüfen wir deinen PC und dessen Weg zum Router.

## Was bleibt offen?
Ob Router, Leitung oder Anbieter verantwortlich ist, ist noch unklar.

## Andere Möglichkeiten
Ping-Antworten können weniger wichtig behandelt werden als Spieldaten.`;

test('plain-language sections keep cause, route, evidence, next step and uncertainty distinct',()=>{
  const result=parseDiagnosisResult(answer);
  assert.equal(result.structured,true);
  assert.equal(result.confidence,'Mittel');
  assert.equal(result.lead,'Die Verbindung vom Router ins Internet macht Probleme.');
  assert.match(result.sections.path,/Router → Internet/);
  assert.match(result.sections.next,/zweiten Gerät/);
  assert.match(result.sections.uncertainty,/noch unklar/);
  assert.match(result.sections.alternatives,/Spieldaten/);
  assert.equal(result.raw,answer);
});

test('legacy results preserve the full answer and do not infer blame or confidence from keywords',()=>{
  const raw='**Befund: Noch nicht eingrenzbar.** Router und Repeater kommen infrage.\n\n1. **Router – Sicherheit: niedrig.** Keine passenden Daten.\n\nNoch mehr Messwerte.';
  const result=parseDiagnosisResult(raw);
  assert.equal(result.structured,false);assert.equal(result.confidence,null);
  assert.equal(result.lead,'**Befund: Noch nicht eingrenzbar.** Router und Repeater kommen infrage.');
  assert.equal(result.raw,raw);
});

test('uncertain and incomplete answers never manufacture a confidence or diagnosis',()=>{
  const result=parseDiagnosisResult('## Am wahrscheinlichsten\nNoch nicht eingrenzbar.\n\n## Wie sicher?\nNoch offen – es fehlen Messungen.');
  assert.equal(result.confidence,'Noch offen');assert.equal(result.sections.next,undefined);
  assert.equal(parseDiagnosisResult('## Warum?\nKeine Werte.').structured,false);
  assert.equal(parseDiagnosisResult('## Am wahrscheinlichsten\nUnbekannt.').confidence,null);
});

test('CRLF and bold headings work while unknown sections remain in the full original',()=>{
  const raw='**Am wahrscheinlichsten**\r\nKabelweg prüfen.\r\n\r\n**Wie sicher?**\r\nNiedrig\r\n\r\n## Eigene Notiz\r\nNicht als Sicherheit interpretieren.';
  const result=parseDiagnosisResult(raw);
  assert.equal(result.lead,'Kabelweg prüfen.');assert.equal(result.confidence,'Niedrig');
  assert.equal(result.sections.confidence,'Niedrig');assert.equal(result.raw,raw);
});

test('model content resembling HTML, commands or links stays unmodified data for safe DOM rendering',()=>{
  const raw='## Am wahrscheinlichsten\n<img src=x onerror=alert(1)> **Router**\n\n## Was jetzt?\n[Link](javascript:alert(1))';
  const result=parseDiagnosisResult(raw);
  assert.match(result.lead,/<img/);assert.equal(result.raw,raw);
});
