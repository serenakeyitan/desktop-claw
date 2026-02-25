const http = require('http');
const https = require('https');
const url = require('url');
const EventEmitter = require('events');
const log = require('./logger');

class ProxyServer extends EventEmitter {
  constructor(port = 9999, apiKey = '') {
    super();
    this.port = port;
    this.apiKey = apiKey;
    this.server = null;
    this.activeRequests = new Set();
  }

  start() {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('connect', (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    this.server.listen(this.port, 'localhost', () => {
      log(`Proxy server listening on localhost:${this.port}`);
    });

    this.server.on('error', (error) => {
      log.error('Proxy server error:', error);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  handleRequest(clientReq, clientRes) {
    const parsedUrl = url.parse(clientReq.url);
    const isAnthropicRequest = parsedUrl.hostname &&
      (parsedUrl.hostname.includes('anthropic.com') ||
       parsedUrl.hostname.includes('claude.ai'));

    // Emit activity for Anthropic API calls
    if (isAnthropicRequest) {
      this.emit('activity');
      this.activeRequests.add(clientReq);
    }

    // Proxy the request
    const options = {
      hostname: parsedUrl.hostname || 'api.anthropic.com',
      port: parsedUrl.port || 443,
      path: parsedUrl.path,
      method: clientReq.method,
      headers: { ...clientReq.headers }
    };

    // Remove proxy-specific headers
    delete options.headers['proxy-connection'];
    delete options.headers['proxy-authorization'];

    // Add API key if not present and we have one
    if (isAnthropicRequest && this.apiKey && !options.headers['x-api-key']) {
      options.headers['x-api-key'] = this.apiKey;
    }

    const protocol = parsedUrl.protocol === 'http:' ? http : https;
    const proxyReq = protocol.request(options, (proxyRes) => {
      // Forward status and headers
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);

      // Pipe the response
      proxyRes.pipe(clientRes);

      proxyRes.on('end', () => {
        if (isAnthropicRequest) {
          this.activeRequests.delete(clientReq);
        }
      });
    });

    proxyReq.on('error', (error) => {
      log.error('Proxy request error:', error);
      clientRes.writeHead(500);
      clientRes.end('Proxy Error');
      if (isAnthropicRequest) {
        this.activeRequests.delete(clientReq);
      }
    });

    // Pipe the client request to proxy request
    clientReq.pipe(proxyReq);
  }

  handleConnect(req, clientSocket, head) {
    // Handle HTTPS CONNECT tunneling
    const { hostname, port } = url.parse(`https://${req.url}`);

    const isAnthropicRequest = hostname &&
      (hostname.includes('anthropic.com') || hostname.includes('claude.ai'));

    if (isAnthropicRequest) {
      this.emit('activity');
    }

    const serverSocket = https.request({
      hostname: hostname,
      port: port || 443,
      method: 'CONNECT'
    });

    serverSocket.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (error) => {
      log.error('Tunnel error:', error);
      clientSocket.end();
    });

    clientSocket.on('error', (error) => {
      log.error('Client socket error:', error);
      serverSocket.end();
    });
  }

  getActiveRequestCount() {
    return this.activeRequests.size;
  }
}

module.exports = ProxyServer;