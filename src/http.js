const https = require("https");

function postJsonWithFetch(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(async (response) => {
    let json = {};
    try {
      json = await response.json();
    } catch (error) {
      json = {};
    }
    return { ok: response.ok, status: response.status, json };
  });
}

function postJsonWithHttps(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const target = new URL(url);

    if (target.protocol !== "https:") {
      reject(new Error("Apenas https e suportado para o captcha."));
      return;
    }

    const options = {
      method: "POST",
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let json = {};
        try {
          json = body ? JSON.parse(body) : {};
        } catch (error) {
          reject(new Error(`Resposta invalida do captcha: ${body}`));
          return;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          json,
        });
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function postJson(url, payload) {
  if (typeof fetch === "function") {
    return postJsonWithFetch(url, payload);
  }

  return postJsonWithHttps(url, payload);
}

module.exports = {
  postJson,
};
