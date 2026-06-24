const host = window.location.hostname;
export const API_BASE = (host === 'localhost' || host === '127.0.0.1')
  ? 'http://localhost:4000'
  : 'https://api.esse-analytics.com';
