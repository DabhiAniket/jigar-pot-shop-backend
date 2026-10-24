import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Minimal Prometheus text-format metrics without extra dependencies: HTTP request counts and
 * latency, MongoDB command latency, event-loop delay and process memory/CPU.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(labels: Record<string, string>, seconds: number): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]!) entry.buckets[i]!++;
    entry.sum += seconds;
    entry.count++;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, entry] of this.series) {
      BUCKETS.forEach((bucket, i) =>
        lines.push(`${this.name}_bucket{${joinLabels(key, `le="${bucket}"`)}} ${entry.buckets[i]}`),
      );
      lines.push(`${this.name}_bucket{${joinLabels(key, 'le="+Inf"')}} ${entry.count}`);
      lines.push(`${this.name}_sum{${key}} ${entry.sum.toFixed(6)}`);
      lines.push(`${this.name}_count{${key}} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

class Counter {
  private readonly series = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Record<string, string>, by = 1): void {
    const key = labelKey(labels);
    this.series.set(key, (this.series.get(key) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.series) lines.push(`${this.name}{${key}} ${value}`);
    return lines.join('\n');
  }
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');
}

function joinLabels(key: string, extra: string): string {
  return key ? `${key},${extra}` : extra;
}

export const httpDuration = new Histogram('http_request_duration_seconds', 'HTTP request latency');
export const httpRequests = new Counter(
  'http_requests_total',
  'HTTP requests by route and status class',
);
export const dbCommandDuration = new Histogram(
  'mongodb_command_duration_seconds',
  'MongoDB command latency',
);
export const jobsProcessed = new Counter(
  'jobs_processed_total',
  'Background jobs by name and outcome',
);

const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();

export function renderMetrics(): string {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const gauges = [
    ['process_resident_memory_bytes', memory.rss],
    ['nodejs_heap_used_bytes', memory.heapUsed],
    ['nodejs_heap_total_bytes', memory.heapTotal],
    ['process_cpu_user_seconds_total', cpu.user / 1e6],
    ['process_cpu_system_seconds_total', cpu.system / 1e6],
    ['nodejs_eventloop_delay_p50_seconds', eventLoop.percentile(50) / 1e9],
    ['nodejs_eventloop_delay_p99_seconds', eventLoop.percentile(99) / 1e9],
    ['nodejs_eventloop_delay_max_seconds', eventLoop.max / 1e9],
    ['process_uptime_seconds', process.uptime()],
  ] as const;
  return (
    [
      ...gauges.map(([name, value]) => `# TYPE ${name} gauge\n${name} ${Number(value).toFixed(6)}`),
      httpRequests.render(),
      httpDuration.render(),
      dbCommandDuration.render(),
      jobsProcessed.render(),
    ].join('\n') + '\n'
  );
}
