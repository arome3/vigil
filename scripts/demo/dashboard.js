// Terminal dashboard UI for Vigil demo presentations.
//
// Exports: Dashboard class
//
// Usage:
//   const dashboard = new Dashboard('Compromised API Key', 1);
//   dashboard.start();
//   dashboard.addActivity('system', 'Injecting data...');
//   dashboard.setAgentState('triage', 'active');
//   dashboard.showResult(summary);
//   dashboard.stop();

import chalk from 'chalk';
import logUpdate from 'log-update';

// Pipeline agents per scenario
const SCENARIO_PIPELINES = {
  1: ['triage', 'investigator', 'threat-hunter', 'commander', 'executor', 'verifier'],
  2: ['sentinel', 'investigator', 'commander', 'executor', 'verifier'],
  3: ['triage', 'investigator', 'commander', 'executor', 'verifier']
};

// State icons
const STATE_ICONS = {
  pending: '\u25CB',     // ○
  active: '\u25CF',      // ●
  complete: '\u2713',    // ✓
  failed: '\u2717',      // ✗
  reflecting: '\u21BB'   // ↻
};

// Agent color map
const AGENT_COLORS = {
  coordinator: chalk.gray,
  triage: chalk.cyan,
  investigator: chalk.yellow,
  'threat-hunter': chalk.magenta,
  sentinel: chalk.blue,
  commander: chalk.blue,
  executor: chalk.green,
  verifier: chalk.white,
  analyst: chalk.gray,
  system: chalk.dim
};

// State colors
const STATE_COLORS = {
  pending: chalk.gray,
  active: chalk.yellow,
  complete: chalk.green,
  failed: chalk.red,
  reflecting: chalk.magenta
};

export class Dashboard {
  constructor(scenarioName, scenarioNumber) {
    this.scenarioName = scenarioName;
    this.scenarioNumber = scenarioNumber;
    this.pipeline = SCENARIO_PIPELINES[scenarioNumber] || SCENARIO_PIPELINES[1];
    this.startTime = null;
    this.agentStates = {};
    for (const agent of this.pipeline) {
      this.agentStates[agent] = 'pending';
    }
    this.activityLog = [];
    this.result = null;
    this.timerInterval = null;
    this.countdownText = null;
    this.reflectionCount = 0;
    this.pass1States = null;
    this.width = Math.min(process.stdout.columns || 80, 80);
  }

  start() {
    this.startTime = Date.now();
    this.timerInterval = setInterval(() => this.render(), 1000);
    this.render();
  }

  setAgentState(agent, state) {
    if (!(agent in this.agentStates)) return;
    // Track reflection transitions
    if (state === 'reflecting' && !this.pass1States) {
      this.reflectionCount++;
      this.pass1States = { ...this.agentStates };
      this.pass1States[agent] = 'failed';
      // Reset pipeline for pass 2 (keep triage complete)
      for (const a of this.pipeline) {
        this.agentStates[a] = 'pending';
      }
      if (this.pipeline.includes('triage')) {
        this.agentStates.triage = 'complete';
      }
      return;
    }
    this.agentStates[agent] = state;
    this.render();
  }

  addActivity(agent, message) {
    const elapsed = this.getElapsed();
    this.activityLog.push({ time: elapsed, agent, message });
    if (this.activityLog.length > 15) {
      this.activityLog.shift();
    }
    this.render();
  }

  updateCountdown(text) {
    this.countdownText = text;
    this.render();
  }

  clearCountdown() {
    this.countdownText = null;
    this.render();
  }

  showResult(summary) {
    this.result = summary;
    this.render();
  }

  stop() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.render();
    logUpdate.done();
  }

  getElapsed() {
    if (!this.startTime) return '00:00';
    const ms = Date.now() - this.startTime;
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / 60000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ─── Rendering ──────────────────────────────────────────────────

  render() {
    const w = this.width;
    const lines = [];

    // Row 1: Header
    lines.push(this._renderHeader(w));

    // Row 2: Pipeline
    lines.push(this._renderPipeline(w));

    // Row 3: Activity Feed
    lines.push(this._renderActivityFeed(w));

    // Row 4: Result
    lines.push(this._renderResult(w));

    logUpdate(lines.join('\n'));
  }

  _box(content, w) {
    const top = '\u250C' + '\u2500'.repeat(w - 2) + '\u2510';
    const bot = '\u2514' + '\u2500'.repeat(w - 2) + '\u2518';
    const mid = '\u251C' + '\u2500'.repeat(w - 2) + '\u2524';
    return { top, bot, mid, row: (text) => '\u2502' + this._pad(text, w - 2) + '\u2502' };
  }

  _pad(text, width) {
    // Strip ANSI for length calculation
    const stripped = text.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - stripped.length);
    return '  ' + text + ' '.repeat(Math.max(0, pad - 2));
  }

  _renderHeader(w) {
    const b = this._box('', w);
    const elapsed = this.getElapsed();
    const status = this.result
      ? chalk.green('\u2713 DONE')
      : chalk.green('\u25CF LIVE');

    const title = chalk.bold('VIGIL AUTONOMOUS SOC');
    const timer = chalk.dim(`\u23F1 ${elapsed} elapsed`);

    const titleLine = `${title}${' '.repeat(Math.max(2, w - 30 - elapsed.length - 14))}${timer}`;
    const scenarioLine = `Scenario ${this.scenarioNumber}: ${this.scenarioName}${' '.repeat(Math.max(2, w - this.scenarioName.length - 24))}${status}`;

    return [
      b.top,
      b.row(titleLine),
      b.row(scenarioLine)
    ].join('\n');
  }

  _renderPipeline(w) {
    const sep = '\u251C' + '\u2500'.repeat(w - 2) + '\u2524';
    const b = this._box('', w);
    const lines = [sep, b.row(chalk.bold('PIPELINE STATUS'))];

    if (this.pass1States && this.reflectionCount > 0) {
      // Two-pass display for reflection scenarios
      lines.push(b.row(''));
      lines.push(b.row(chalk.dim('Pass 1:')));
      lines.push(b.row(this._buildPipelineRow(this.pass1States)));
      lines.push(b.row(''));
      lines.push(b.row(chalk.magenta(`  \u21BB REFLECTION LOOP (${this.reflectionCount})`)));
      lines.push(b.row(''));
      lines.push(b.row(chalk.dim('Pass 2:')));
      lines.push(b.row(this._buildPipelineRow(this.agentStates)));
    } else {
      lines.push(b.row(''));
      lines.push(b.row(this._buildPipelineRow(this.agentStates)));
    }

    lines.push(b.row(''));
    const legend = `${chalk.gray('\u25CB')} pending  ${chalk.yellow('\u25CF')} active  ${chalk.green('\u2713')} complete  ${chalk.red('\u2717')} failed  ${chalk.magenta('\u21BB')} reflecting`;
    lines.push(b.row(legend));

    return lines.join('\n');
  }

  _buildPipelineRow(states) {
    const parts = [];
    for (const agent of this.pipeline) {
      const state = states[agent] || 'pending';
      const icon = STATE_ICONS[state];
      const colorFn = STATE_COLORS[state];
      const agentColor = AGENT_COLORS[agent] || chalk.white;
      parts.push(colorFn(icon) + ' ' + agentColor(agent));
    }
    return parts.join(chalk.dim(' \u25B6 '));
  }

  _renderActivityFeed(w) {
    const sep = '\u251C' + '\u2500'.repeat(w - 2) + '\u2524';
    const b = this._box('', w);
    const lines = [sep, b.row(chalk.bold('AGENT ACTIVITY FEED')), b.row('')];

    const maxLines = 12;
    const entries = this.activityLog.slice(-maxLines);

    for (const entry of entries) {
      const colorFn = AGENT_COLORS[entry.agent] || chalk.white;
      const agentLabel = colorFn(entry.agent.padEnd(18));
      const line = `${chalk.dim(entry.time)}  ${agentLabel}  ${entry.message}`;
      lines.push(b.row(line));
    }

    // Pad empty lines
    const remaining = maxLines - entries.length;
    for (let i = 0; i < remaining; i++) {
      lines.push(b.row(''));
    }

    // Countdown line
    if (this.countdownText) {
      lines.push(b.row(chalk.yellow(this.countdownText)));
    }

    return lines.join('\n');
  }

  _renderResult(w) {
    const sep = '\u251C' + '\u2500'.repeat(w - 2) + '\u2524';
    const bot = '\u2514' + '\u2500'.repeat(w - 2) + '\u2518';
    const b = this._box('', w);

    if (!this.result) {
      return [
        sep,
        b.row(chalk.bold('RESULT')),
        b.row(''),
        b.row(chalk.dim('  (waiting for resolution...)')),
        b.row(''),
        bot
      ].join('\n');
    }

    const r = this.result;
    const lines = [sep];

    // Header
    const resolvedLabel = r.reflection_count > 0
      ? chalk.green('\u2713 INCIDENT RESOLVED (after reflection)')
      : chalk.green('\u2713 INCIDENT RESOLVED');
    const duration = r.total_duration
      ? this._formatDuration(r.total_duration)
      : this.getElapsed();
    lines.push(b.row(`${resolvedLabel}${' '.repeat(Math.max(2, 20))}${chalk.dim(`\u23F1 ${duration}`)}`));
    lines.push(b.row(''));

    // Incident details
    if (r.incident_id) lines.push(b.row(`Incident:    ${r.incident_id}`));
    if (r.type) lines.push(b.row(`Type:        ${r.type}`));
    if (r.severity) lines.push(b.row(`Severity:    ${chalk.bold(String(r.severity).toUpperCase())}`));
    if (r.priority) lines.push(b.row(`Priority:    ${r.priority}`));
    lines.push(b.row(''));

    // Agents chain
    if (r.agents && r.agents.length > 0) {
      const agentChain = r.agents.map(a => {
        const colorFn = AGENT_COLORS[a.replace('vigil-', '')] || chalk.white;
        return colorFn(a.replace('vigil-', ''));
      }).join(chalk.dim(' \u2192 '));
      lines.push(b.row(`Agents:      ${agentChain}`));
      lines.push(b.row(''));
    }

    // Root cause
    if (r.root_cause) {
      const wrapped = this._wrapText(r.root_cause, w - 18);
      lines.push(b.row(`Root Cause:  ${wrapped[0]}`));
      for (let i = 1; i < wrapped.length; i++) {
        lines.push(b.row(`             ${wrapped[i]}`));
      }
      lines.push(b.row(''));
    }

    // MITRE mapping (Scenario 1)
    if (r.mitre && r.mitre.length > 0) {
      const mitreChain = r.mitre.map(m => m.technique_id || m).join(' \u2192 ');
      lines.push(b.row(`MITRE:       ${mitreChain}`));
      lines.push(b.row(''));
    }

    // Actions
    if (r.actions && r.actions.length > 0) {
      lines.push(b.row(`Actions:     ${r.actions.length} actions executed`));
      for (const action of r.actions.slice(0, 6)) {
        const desc = action.description || action.action_type || String(action);
        lines.push(b.row(`  ${chalk.green('\u2713')} ${desc}`));
      }
      lines.push(b.row(''));
    }

    // Health score
    if (r.health_score !== undefined) {
      const passed = r.health_score >= 0.8;
      const hLabel = passed ? chalk.green('PASSED') : chalk.red('FAILED');
      lines.push(b.row(`Health:      ${r.health_score} (${hLabel})`));
    }

    // Reflection count
    if (r.reflection_count !== undefined) {
      lines.push(b.row(`Reflections: ${r.reflection_count}`));
    }

    lines.push(b.row(''));

    // Timing breakdown
    if (r.timing && typeof r.timing === 'object') {
      const innerW = w - 10;
      const tTop = '\u250C' + '\u2500'.repeat(innerW) + '\u2510';
      const tBot = '\u2514' + '\u2500'.repeat(innerW) + '\u2518';
      const tRow = (t) => '\u2502' + this._padInner(t, innerW) + '\u2502';

      lines.push(b.row(`  ${tTop}`));
      lines.push(b.row(`  ${tRow(chalk.bold('Timing Breakdown'))}`));

      for (const [phase, seconds] of Object.entries(r.timing)) {
        if (typeof seconds === 'number') {
          const label = phase.replace(/_/g, ' ');
          lines.push(b.row(`  ${tRow(`${label}: ${this._formatDuration(seconds)}`)}`));
        }
      }

      if (r.total_duration) {
        lines.push(b.row(`  ${tRow('\u2500'.repeat(innerW - 4))}`));
        lines.push(b.row(`  ${tRow(`Total: ${this._formatDuration(r.total_duration)}`)}`));
      }
      lines.push(b.row(`  ${tBot}`));
      lines.push(b.row(''));
    }

    // Tagline
    const tagline = this._getTagline(r);
    if (tagline) {
      lines.push(b.row(chalk.italic(tagline)));
      lines.push(b.row(''));
    }

    lines.push(bot);
    return lines.join('\n');
  }

  _getTagline(result) {
    if (this.scenarioNumber === 1) {
      const actionCount = result.actions?.length || 5;
      const duration = result.total_duration
        ? this._formatDuration(result.total_duration)
        : this.getElapsed();
      return `"11 agents. ${actionCount} actions. ${duration}. Zero humans."`;
    }
    if (this.scenarioNumber === 2) {
      return '"The agent identified the exact commit, author, and code change\n             \u2014 context that takes a human SRE 15-30 minutes."';
    }
    if (this.scenarioNumber === 3) {
      return '"When the first fix didn\'t work, Vigil didn\'t give up.\n             It re-investigated and tried a different approach. Autonomously."';
    }
    return null;
  }

  _formatDuration(seconds) {
    if (typeof seconds !== 'number') return String(seconds);
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  _wrapText(text, maxWidth) {
    if (!text) return [''];
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxWidth && current.length > 0) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  _padInner(text, width) {
    const stripped = text.replace(/\x1B\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - stripped.length);
    return ' ' + text + ' '.repeat(Math.max(0, pad - 1));
  }
}
