const host = window.location.hostname;
const port = window.location.port;

// El Electron local sirve frontend + API en el puerto 4000 (también accesible por IP de red local).
// Si la página viene de ahí, las llamadas deben ir al backend local en el MISMO host — no a la central.
const isLocalhost   = host === 'localhost' || host === '127.0.0.1';
const isLocalServed = port === '4000';

export const API_BASE = (isLocalhost || isLocalServed)
  ? `http://${host}:4000`
  : 'https://api.esse-analytics.com';
