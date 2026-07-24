import { createProxyMiddleware } from 'http-proxy-middleware';

const CENTRAL = process.env.CENTRAL_API || 'https://api.esse-analytics.com';

// La Biblioteca remota (Premium + storage en la nube) vive ENTERA en la central
// -- bytes de video, Mongo, todo -- nunca en SQLite. A diferencia de auth-proxy.routes.ts
// (que reserializa JSON con fetch), esto necesita ser un proxy de bytes crudo:
// subida TUS (chunks binarios por PATCH) y streaming de video con range-requests no
// sobreviven un JSON.stringify(req.body)/res.json() de ida y vuelta. Por eso se monta
// ANTES de express.json() en server.ts -- si el body-parser llega primero, el stream
// del request ya está consumido y el proxy reenvía un body vacío.
export const remoteLibraryProxy = createProxyMiddleware({
  target: CENTRAL,
  changeOrigin: true,
  ws: false,
  // app.use('/api/remote-library', remoteLibraryProxy) en server.ts hace que Express
  // le pase el request con el prefijo YA RECORTADO (req.url = "/videos", no
  // "/api/remote-library/videos") -- sin esto el proxy reenvía la ruta recortada y la
  // central responde 404 porque esa ruta no existe ahí.
  pathRewrite: (path) => `/api/remote-library${path}`,
  on: {
    // El CORS de la central solo permite esse-analytics.com -- las peticiones
    // que llegan acá vía este proxy son de Electron (Origin tipo file:// o
    // http://localhost:xxxx, según cómo cargue la ventana), y http-proxy
    // reenvía el header Origin del cliente tal cual salvo que se lo saquemos
    // acá. Sin esto, la central las rechaza con "Origen no permitido por
    // CORS" -- este proxy YA es la barrera de confianza (solo local-backend
    // le habla a la central con el JWT del usuario), así que se tratan como
    // lo que son: server-a-servidor, sin Origin.
    proxyReq: (proxyReq) => {
      proxyReq.removeHeader('origin');
    },
    // @tus/server arma el header Location con la URL que VE (la de la central,
    // detrás de este proxy) -- sin reescribirlo, tus-js-client intentaría mandar
    // los siguientes chunks PATCH directo a la central, saltándose el proxy (y
    // fallando: la central no es alcanzable directo desde el cliente).
    proxyRes: (proxyRes, req) => {
      const location = proxyRes.headers.location;
      if (location?.startsWith(CENTRAL)) {
        proxyRes.headers.location = location.replace(CENTRAL, `${req.protocol}://${req.headers.host}`);
      }
    },
  },
});
