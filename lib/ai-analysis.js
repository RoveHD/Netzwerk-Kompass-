import { CodexClient } from './codex.js';
import { buildDiagnosticReport, diagnosticPrompt } from './report.js';
import { randomUUID } from 'node:crypto';

export class AnalysisController {
  constructor(monitor, { client = new CodexClient() } = {}) {
    this.monitor = monitor; this.client = client; this.epoch = 0; this.closed = false;
    this.state = { connection: { available: false, authenticated: false, authMode: null, checking: false, message: 'Codex-Verbindung noch nicht geprüft.' }, running: false, loginRunning: false, status: 'idle', message: '', error: '', result: null, startedAt: null, finishedAt: null, reportSummary: null, measurementStartedAt: monitor.state.measurementStartedAt || null };
    this.ready = monitor.persistence.start();
  }
  snapshot() {
    this.state.savedAnalyses = this.monitor.persistence.analyses.map(({report,...item})=>({...item}));
    this.state.persistenceError = this.monitor.persistence.lastError;
    if(!this.epoch && !this.monitor.starting) {
      const latest=this.monitor.persistence.analyses.find(item=>item.measurementStartedAt===(this.monitor.state.measurementStartedAt||null));
      if(latest)Object.assign(this.state,{status:latest.status,result:latest.result||null,error:latest.error||'',startedAt:latest.startedAt,finishedAt:latest.finishedAt,reportSummary:latest.reportSummary,measurementStartedAt:latest.measurementStartedAt,analysisId:latest.id,message:'Gespeicherte Auswertung aus einer früheren Sitzung.'});
    }
    return this.state;
  }
  persistAnalysis(record) {
    const task=this.monitor.persistence.saveAnalysis(record);
    // Saving failures remain visible independently of the actual AI result.
    this.saveJob=task.catch(()=>{});
    return this.saveJob;
  }
  preview(hours) { return buildDiagnosticReport(this.monitor, { hours }); }
  ensureChecked() { if (!this.checked && !this.checking && !this.closed) this.check().catch(() => {}); }
  async check() {
    if (this.checking) return this.checking;
    if (this.closed || this.state.running || this.state.loginRunning) return this.snapshot();
    this.state.connection.checking = true;
    this.checking = (async () => {
      try { this.state.connection = { ...await this.client.check(), checking: false }; }
      catch { this.state.connection = { available: false, authenticated: false, authMode: null, checking: false, message: 'Codex-Verbindung konnte nicht geprüft werden. Bitte Codex CLI prüfen.' }; }
      finally { this.checked = true; this.state.connection.checking = false; }
      return this.snapshot();
    })();
    try { return await this.checking; } finally { this.checking = null; }
  }
  assertIdle() {
    if (this.closed) throw new Error('Das Programm wird beendet.');
    if (this.state.running || this.state.loginRunning || this.checking) { const error = new Error('Bitte die laufende Codex-Aktion abwarten oder abbrechen.'); error.code = 'ANALYSIS_BUSY'; throw error; }
  }
  start(hours = 1) {
    this.assertIdle();
    const { report, summary } = this.preview(hours);
    if (!summary.records) throw new Error('Noch keine Messdaten vorhanden. Bitte zuerst die Überwachung laufen lassen.');
    const epoch = ++this.epoch; const abort = this.abort = new AbortController();
    Object.assign(this.state, { running: true, loginRunning: false, status: 'running', result: null, error: '', message: 'Codex prüft das Diagnoseprotokoll …', startedAt: new Date().toISOString(), finishedAt: null, reportSummary: summary, measurementStartedAt: this.monitor.state.measurementStartedAt || null });
    const record=this.activeAnalysis={id:randomUUID(),sessionId:this.monitor.persistence.currentSession?.id||null,startedAt:this.state.startedAt,finishedAt:null,status:'running',result:null,error:'',hours,reportSummary:summary,measurementStartedAt:this.state.measurementStartedAt,report};
    this.state.analysisId=record.id;
    this.job = (async () => {
      try {
        if(this.monitor.dataDir){await this.ready;await this.persistAnalysis(record);}
        if(epoch!==this.epoch||this.closed)return;
        const connection = await this.client.check();
        if (epoch !== this.epoch || this.closed) return;
        this.state.connection = { ...connection, checking: false };
        if (!connection.available || !connection.authenticated) throw new Error(connection.message || 'Bitte zuerst bei Codex anmelden.');
        const result = await this.client.analyze(diagnosticPrompt(report), { signal: abort.signal });
        if (epoch !== this.epoch || this.closed) return;
        Object.assign(this.state, { status: 'completed', result, message: 'Auswertung fertig. Die Einschätzung bezieht sich auf den beim Klick erfassten Bericht.' });
      } catch (error) {
        if (epoch !== this.epoch || this.closed) return;
        Object.assign(this.state, { status: 'error', error: error.message || 'Auswertung fehlgeschlagen.', result: null, message: '' });
      } finally {
        if (epoch === this.epoch && !this.closed) {
          this.state.running = false; this.state.finishedAt = new Date().toISOString();
          Object.assign(record,{status:this.state.status,result:this.state.result,error:this.state.error,finishedAt:this.state.finishedAt});
          await this.persistAnalysis(record);
          if(this.activeAnalysis===record)this.activeAnalysis=null;
        }
      }
    })();
    return { ok: true };
  }
  login() {
    this.assertIdle();
    if (!this.state.connection.available) throw new Error('Codex CLI wurde noch nicht gefunden. Bitte zuerst die Verbindung prüfen.');
    const epoch = ++this.epoch; const abort = this.abort = new AbortController();
    Object.assign(this.state, { loginRunning: true, status: 'idle', error: '', message: 'Codex-Anmeldung im Browser abschließen. Zugangsdaten bleiben bei Codex.' });
    this.job = (async () => {
      try {
        await this.client.login({ signal: abort.signal });
        if (epoch !== this.epoch || this.closed) return;
        const connection = await this.client.check();
        if (epoch !== this.epoch || this.closed) return;
        this.state.connection = { ...connection, checking: false };
        this.state.message = connection.authenticated ? 'Codex ist angemeldet. Du kannst jetzt die Diagnose senden.' : connection.message;
      } catch (error) {
        if (epoch === this.epoch && !this.closed) Object.assign(this.state, { status: 'error', error: error.message || 'Anmeldung fehlgeschlagen.', message: '' });
      } finally { if (epoch === this.epoch && !this.closed) this.state.loginRunning = false; }
    })();
    return { ok: true };
  }
  cancel() {
    const active = this.state.running || this.state.loginRunning;
    this.epoch++; this.abort?.abort(); this.client.cancel?.();
    if (active) Object.assign(this.state, { running: false, loginRunning: false, status: 'cancelled', result: null, error: '', message: 'Codex-Aktion abgebrochen. Bereits gesendete Daten lassen sich nicht zurückholen.', finishedAt: new Date().toISOString() });
    if(this.activeAnalysis) {
      if(this.activeAnalysis.status==='running') {
        Object.assign(this.activeAnalysis,{status:'cancelled',result:null,error:'',finishedAt:new Date().toISOString()});
        this.persistAnalysis(this.activeAnalysis);
      }
      this.activeAnalysis=null;
    }
    return { ok: true };
  }
  reset() {
    this.cancel();
    Object.assign(this.state, { status: 'idle', result: null, error: '', message: '', startedAt: null, finishedAt: null, reportSummary: null, measurementStartedAt: this.monitor.state.measurementStartedAt || null });
  }
  close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;this.cancel();
    this.closePromise=(async()=>{await this.client.close?.();await this.job;await this.saveJob;await this.monitor.persistence.queue;})();
    return this.closePromise;
  }
}
