module.exports = {
  apps: [
    {
      name: 'tradooor-backend',
      script: 'pnpm',
      args: '--filter backend start',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-frontend',
      script: 'pnpm',
      args: '--filter frontend start',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        PORT: '4444',
      },
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 5,
      min_uptime: '30s', // Increase to 30s to allow server to fully start
      max_memory_restart: '500M',
    },
    {
      name: 'tradooor-metrics-cron',
      script: 'pnpm',
      args: '--filter backend metrics:cron',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        CRON_SCHEDULE: '0 * * * *', // Každou hodinu
        RUN_ON_START: 'true', // Spusť hned při startu
      },
      error_file: './logs/metrics-cron-error.log',
      out_file: './logs/metrics-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-missing-trades-cron',
      script: 'pnpm',
      args: '--filter backend check-missing-trades:cron',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        CRON_SCHEDULE: '0 */3 * * *', // Každé 3 hodiny (sníženo z každé hodiny)
        RUN_ON_START: 'true', // Spusť hned při startu
      },
      error_file: './logs/missing-trades-cron-error.log',
      out_file: './logs/missing-trades-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-normalized-trade-processor',
      script: 'pnpm',
      args: '--filter backend worker:normalized-trades',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/normalized-trade-processor-error.log',
      out_file: './logs/normalized-trade-processor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-recalculate-closed-positions-24h',
      script: 'pnpm',
      args: '--filter backend recalculate:closed-positions-24h',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/recalculate-closed-positions-24h-error.log',
      out_file: './logs/recalculate-closed-positions-24h-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: false, // Run once, not continuously
      cron_restart: '0 2 * * *', // Run daily at 2 AM
    },
    // IMPORTANT: This worker processes the wallet queue for metrics recalculation
    // When a trade is processed, the wallet is enqueued for metrics update
    // This worker picks up those jobs and recalculates closed lots + metrics
    {
      name: 'tradooor-wallet-processing-queue',
      script: 'pnpm',
      args: '--filter backend metrics:worker',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        METRICS_WORKER_IDLE_MS: '3000', // 3 seconds idle between jobs
      },
      error_file: './logs/wallet-processing-queue-error.log',
      out_file: './logs/wallet-processing-queue-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    // Position Monitor - tracks virtual positions and generates exit signals
    {
      name: 'tradooor-position-monitor',
      script: 'pnpm',
      args: '--filter backend position:monitor',
      cwd: process.cwd(),
      env: {
        NODE_ENV: 'production',
        POSITION_UPDATE_INTERVAL_MS: '60000', // 1 minute (checks every minute, updates based on market cap)
      },
      error_file: './logs/position-monitor-error.log',
      out_file: './logs/position-monitor-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
