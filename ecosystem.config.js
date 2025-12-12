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
      },
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
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
        CRON_SCHEDULE: '0 * * * *', // Každou hodinu
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
  ],
};
