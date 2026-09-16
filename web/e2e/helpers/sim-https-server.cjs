// Static https server for the charger-sim mirror during instrumented
// e2e runs. The wallet page (public https) frames this origin; serving
// https (self-signed; the test context sets ignoreHTTPSErrors) plus
// the config's --disable-web-security keeps Chrome's mixed-content /
// private-network policies from blocking the localhost iframe.
//
//   node e2e/helpers/sim-https-server.js <web-root> &
//
// Listens on https://127.0.0.1:8793. Cert lives in /tmp/sim-https.
const https = require("https");
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2];
const CERTDIR = "/tmp/sim-https";
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
};

https.createServer(
  {
    key: fs.readFileSync(path.join(CERTDIR, "key.pem")),
    cert: fs.readFileSync(path.join(CERTDIR, "cert.pem")),
  },
  (req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
    fs.readFile(p, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
      res.end(data);
    });
  },
).listen(8793, "127.0.0.1", () => console.log("sim mirror: https://127.0.0.1:8793"));
