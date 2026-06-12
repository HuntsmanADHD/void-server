/**
 * IPFS Service
 *
 * Manages IPFS pinning for files and directories.
 * Uses HTTP API for Docker compatibility, falls back to CLI for native installations.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Configuration paths
const DATA_DIR = path.resolve(__dirname, '../../data/ipfs');
const CONFIG_PATH = path.resolve(__dirname, '../../data/ipfs.json');
const PINS_PATH = path.join(DATA_DIR, 'pins.json');
const TEMPLATE_PATH = path.resolve(__dirname, '../../data_template/ipfs.json');

// Default configuration
const DEFAULT_CONFIG = {
  enabled: true,
  gateway: 'http://localhost:8088/ipfs',
  apiUrl: process.env.IPFS_API_URL || 'http://localhost:5001',
  publicGateway: 'https://gateway.pinata.cloud/ipfs',
  pinata: {
    enabled: false,
    jwt: '',
    gateway: 'https://gateway.pinata.cloud/ipfs'
  }
};

// Pinata API
const PINATA_API = 'https://api.pinata.cloud';

// File type mappings
const FILE_TYPE_MAP = {
  // Images
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff'],
  // Documents
  document: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'],
  // Media
  media: ['mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'avi', 'mov', 'mkv', 'm4a', 'aac'],
  // Code
  code: ['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'yaml', 'yml', 'md', 'sh', 'sol'],
  // Archives
  archive: ['zip', 'tar', 'gz', 'rar', '7z', 'bz2']
};

/**
 * Initialize data directory and config
 */
async function initialize() {
  // Ensure data directory exists
  await fs.mkdir(DATA_DIR, { recursive: true });

  // Initialize config from template if needed
  const configExists = fsSync.existsSync(CONFIG_PATH);
  if (!configExists) {
    const templateExists = fsSync.existsSync(TEMPLATE_PATH);
    if (templateExists) {
      await fs.copyFile(TEMPLATE_PATH, CONFIG_PATH);
      console.log('📋 IPFS config initialized from template');
    } else {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log('📋 IPFS config initialized with defaults');
    }
  } else {
    // Migrate old Docker hostnames to localhost (v0.13.5+)
    const content = await fs.readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(content);
    let needsSave = false;

    // Fix Docker hostnames (from when running in Docker mode)
    if (config.apiUrl && !config.apiUrl.includes('localhost') && !config.apiUrl.includes('127.0.0.1')) {
      config.apiUrl = 'http://localhost:5001';
      needsSave = true;
    }
    if (config.gateway && !config.gateway.includes('localhost') && !config.gateway.includes('127.0.0.1') && !config.gateway.includes('pinata')) {
      config.gateway = 'http://localhost:8088/ipfs';
      needsSave = true;
    }

    if (needsSave) {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('📋 IPFS config migrated to localhost (from Docker hostnames)');
    }
  }

  // Initialize pins registry if needed
  const pinsExists = fsSync.existsSync(PINS_PATH);
  if (!pinsExists) {
    await fs.writeFile(PINS_PATH, JSON.stringify({ pins: [], stats: { totalPinned: 0, lastPinned: null } }, null, 2));
  }
}

/**
 * Load configuration
 */
async function loadConfig() {
  await initialize();
  const content = await fs.readFile(CONFIG_PATH, 'utf8');
  const envOverrides = {};
  if (process.env.IPFS_API_URL) envOverrides.apiUrl = process.env.IPFS_API_URL;
  if (process.env.IPFS_GATEWAY_URL) envOverrides.gateway = process.env.IPFS_GATEWAY_URL;
  return { ...DEFAULT_CONFIG, ...JSON.parse(content), ...envOverrides };
}

/**
 * Save configuration
 */
async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Detect file type from filename
 */
function detectFileType(filename) {
  const ext = path.extname(filename).toLowerCase().slice(1);
  for (const [type, extensions] of Object.entries(FILE_TYPE_MAP)) {
    if (extensions.includes(ext)) return type;
  }
  return 'other';
}

/**
 * Make HTTP request to IPFS API
 */
function ipfsRequest(endpoint, options = {}) {
  return new Promise(async (resolve, reject) => {
    const config = await loadConfig();
    const apiUrl = new URL(config.apiUrl);
    const isHttps = apiUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || (isHttps ? 443 : 5001),
      path: `/api/v0/${endpoint}`,
      method: options.method || 'POST',
      headers: options.headers || {},
      timeout: options.timeout || 30000
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // IPFS API returns newline-delimited JSON for some endpoints
          const lines = data.trim().split('\n');
          const results = lines.map(line => {
            if (!line) return null;
            return JSON.parse(line);
          }).filter(Boolean);
          resolve(results.length === 1 ? results[0] : results);
        } else {
          reject(new Error(`IPFS API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('IPFS API timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Check if IPFS daemon is running
 */
async function checkDaemon() {
  const result = await ipfsRequest('id');
  return { online: true, peerId: result.ID, addresses: result.Addresses };
}

/**
 * Check NAT/network reachability status
 * Analyzes node addresses to determine if publicly reachable
 */
async function checkNatStatus() {
  const result = await ipfsRequest('id');
  const addresses = result.Addresses || [];

  // Categorize addresses
  const publicAddrs = [];
  const relayAddrs = [];
  const localAddrs = [];

  for (const addr of addresses) {
    if (addr.includes('/p2p-circuit/')) {
      relayAddrs.push(addr);
    } else if (addr.includes('/ip4/127.') || addr.includes('/ip4/192.168.') ||
               addr.includes('/ip4/10.') || addr.includes('/ip4/172.16.') ||
               addr.includes('/ip6/::1') || addr.includes('/ip6/fe80')) {
      localAddrs.push(addr);
    } else if (addr.includes('/ip4/') || addr.includes('/ip6/')) {
      // Check if it's a routable public IP
      const ipMatch = addr.match(/\/ip4\/(\d+\.\d+\.\d+\.\d+)/);
      if (ipMatch) {
        const ip = ipMatch[1];
        // Skip CGNAT range (100.64.0.0/10)
        if (!ip.startsWith('100.64.') && !ip.startsWith('100.65.') &&
            !ip.startsWith('100.66.') && !ip.startsWith('100.67.')) {
          publicAddrs.push(addr);
        }
      } else {
        publicAddrs.push(addr); // IPv6 public
      }
    }
  }

  // Determine reachability status
  let status = 'unknown';
  let message = '';

  if (publicAddrs.length > 0) {
    status = 'public';
    message = 'Your node is publicly reachable. Content you pin will be accessible via public gateways.';
  } else if (relayAddrs.length > 0) {
    status = 'relay';
    message = 'Your node is behind NAT and using relay circuits. Content may be slow or unreachable from public gateways. Consider port forwarding UDP/TCP 4001.';
  } else if (localAddrs.length > 0) {
    status = 'local';
    message = 'Your node only has local addresses. It cannot serve content to the public network.';
  } else {
    status = 'offline';
    message = 'No addresses found. IPFS daemon may not be fully initialized.';
  }

  // Get peer count for additional context
  let peerCount = 0;
  const peersResult = await ipfsRequest('swarm/peers');
  peerCount = peersResult.Peers?.length || 0;

  return {
    status,
    message,
    publicAddrs,
    relayAddrs,
    localAddrs,
    peerCount,
    isPubliclyReachable: status === 'public',
    needsPortForward: status === 'relay' || status === 'local'
  };
}

/**
 * Pin a file to IPFS via HTTP API
 */
async function pinFile(filePath, metadata = {}) {
  const config = await loadConfig();
  const fileContent = await fs.readFile(filePath);
  const filename = path.basename(filePath);
  const stats = await fs.stat(filePath);

  // Create form data for multipart upload
  const boundary = '----IPFSBoundary' + Date.now();
  const formData = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    fileContent.toString('binary'),
    `--${boundary}--`
  ].join('\r\n');

  const result = await ipfsRequest('add?pin=true', {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(formData, 'binary')
    },
    body: Buffer.from(formData, 'binary')
  });

  const pin = {
    cid: result.Hash,
    name: metadata.name || filename,
    type: metadata.type || detectFileType(filename),
    size: stats.size,
    pinnedAt: new Date().toISOString(),
    gatewayUrl: `${config.gateway}/${result.Hash}`,
    source: metadata.source || 'upload'
  };

  await addPinToRegistry(pin);
  console.log(`📌 Pinned file: ${pin.cid} (${pin.name})`);
  return pin;
}

/**
 * Pin content from a URL
 */
async function pinUrl(url, metadata = {}) {
  const config = await loadConfig();

  // Fetch the URL content
  const content = await new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return pinUrl(res.headers.location, metadata).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  // Extract filename from URL
  const urlPath = new URL(url).pathname;
  const filename = metadata.name || path.basename(urlPath) || 'unnamed';

  // Create form data
  const boundary = '----IPFSBoundary' + Date.now();
  const formData = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    content.toString('binary'),
    `--${boundary}--`
  ].join('\r\n');

  const result = await ipfsRequest('add?pin=true', {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(formData, 'binary')
    },
    body: Buffer.from(formData, 'binary')
  });

  const pin = {
    cid: result.Hash,
    name: filename,
    type: metadata.type || detectFileType(filename),
    size: content.length,
    pinnedAt: new Date().toISOString(),
    gatewayUrl: `${config.gateway}/${result.Hash}`,
    source: 'url',
    sourceUrl: url
  };

  await addPinToRegistry(pin);
  console.log(`📌 Pinned URL: ${pin.cid} (${url})`);
  return pin;
}

/**
 * Pin a directory recursively
 */
async function pinDirectory(dirPath, metadata = {}) {
  const config = await loadConfig();
  const dirname = path.basename(dirPath);

  // Get directory size
  const size = await getDirectorySize(dirPath);

  // Build multipart form with all files
  const boundary = '----IPFSBoundary' + Date.now();
  const parts = [];

  async function addFiles(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await addFiles(fullPath, relativePath);
      } else {
        const content = await fs.readFile(fullPath);
        parts.push(
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${relativePath}"`,
          'Content-Type: application/octet-stream',
          '',
          content.toString('binary')
        );
      }
    }
  }

  await addFiles(dirPath);
  parts.push(`--${boundary}--`);

  const formData = parts.join('\r\n');

  // Add with wrap-with-directory to get a single CID for the whole directory
  const results = await ipfsRequest('add?pin=true&wrap-with-directory=true', {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(formData, 'binary')
    },
    body: Buffer.from(formData, 'binary'),
    timeout: 120000
  });

  // Last result is the directory wrapper
  const dirResult = Array.isArray(results) ? results[results.length - 1] : results;

  const pin = {
    cid: dirResult.Hash,
    name: metadata.name || dirname,
    type: 'directory',
    size: size,
    pinnedAt: new Date().toISOString(),
    gatewayUrl: `${config.gateway}/${dirResult.Hash}`,
    source: 'directory'
  };

  await addPinToRegistry(pin);
  console.log(`📌 Pinned directory: ${pin.cid} (${dirname})`);
  return pin;
}

/**
 * Unpin content from IPFS
 */
async function unpin(cid) {
  await ipfsRequest(`pin/rm?arg=${cid}`);
  await removePinFromRegistry(cid);
  console.log(`📤 Unpinned: ${cid}`);
  return { success: true, cid };
}

/**
 * List all pins from registry
 */
async function listPins() {
  await initialize();
  const content = await fs.readFile(PINS_PATH, 'utf8');
  const data = JSON.parse(content);
  return data.pins || [];
}

/**
 * Get service status
 */
async function getStatus() {
  await initialize();
  const config = await loadConfig();

  let daemonOnline = false;
  let peerId = null;
  let natStatus = null;

  const status = await checkDaemon();
  daemonOnline = status.online;
  peerId = status.peerId;

  // Get NAT status if daemon is online
  if (daemonOnline) {
    natStatus = await checkNatStatus();
  }

  const pins = await listPins();

  // Calculate metrics by type
  const metrics = {
    totalPins: pins.length,
    byType: {}
  };

  for (const pin of pins) {
    const type = pin.type || 'other';
    metrics.byType[type] = (metrics.byType[type] || 0) + 1;
  }

  return {
    enabled: config.enabled,
    daemonOnline,
    peerId,
    gateway: config.gateway,
    publicGateway: config.publicGateway,
    apiUrl: config.apiUrl,
    metrics,
    config,
    nat: natStatus
  };
}

// Registry helpers

async function addPinToRegistry(pin) {
  const content = await fs.readFile(PINS_PATH, 'utf8');
  const data = JSON.parse(content);

  // Check for duplicate
  const existing = data.pins.find(p => p.cid === pin.cid);
  if (!existing) {
    data.pins.unshift(pin); // Add to beginning (newest first)
    data.stats.totalPinned = data.pins.length;
    data.stats.lastPinned = pin.pinnedAt;
    await fs.writeFile(PINS_PATH, JSON.stringify(data, null, 2));
  }

  return pin;
}

async function removePinFromRegistry(cid) {
  const content = await fs.readFile(PINS_PATH, 'utf8');
  const data = JSON.parse(content);

  data.pins = data.pins.filter(p => p.cid !== cid);
  data.stats.totalPinned = data.pins.length;
  await fs.writeFile(PINS_PATH, JSON.stringify(data, null, 2));
}

async function getDirectorySize(dirPath) {
  let size = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += await getDirectorySize(fullPath);
    } else {
      const stats = await fs.stat(fullPath);
      size += stats.size;
    }
  }

  return size;
}

// ============================================================================
// Pinata Integration
// ============================================================================

/**
 * Make request to Pinata API
 */
function pinataRequest(endpoint, options = {}) {
  return new Promise(async (resolve, reject) => {
    const config = await loadConfig();
    const jwt = config.pinata?.jwt;

    if (!jwt) {
      return reject(new Error('Pinata JWT not configured'));
    }

    const url = new URL(endpoint, PINATA_API);

    const reqOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: options.method || 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        ...options.headers
      },
      timeout: options.timeout || 60000
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Pinata API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Pinata API timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Check Pinata authentication
 */
async function checkPinata() {
  const config = await loadConfig();
  if (!config.pinata?.jwt) {
    return { configured: false, authenticated: false };
  }

  const result = await pinataRequest('/data/testAuthentication', { method: 'GET' });
  return { configured: true, authenticated: true, message: result.message };
}

/**
 * Pin file to Pinata
 */
async function pinFileToPinata(filePath, metadata = {}) {
  const config = await loadConfig();
  const fileContent = await fs.readFile(filePath);
  const filename = metadata.name || path.basename(filePath);

  // Build multipart form data
  const boundary = '----PinataBoundary' + Date.now();

  const pinataMetadata = JSON.stringify({
    name: filename,
    keyvalues: {
      type: metadata.type || detectFileType(filename),
      source: 'void-server'
    }
  });

  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: application/octet-stream',
    '',
    fileContent.toString('binary'),
    `--${boundary}`,
    'Content-Disposition: form-data; name="pinataMetadata"',
    'Content-Type: application/json',
    '',
    pinataMetadata,
    `--${boundary}--`
  ];

  const formData = parts.join('\r\n');

  const result = await pinataRequest('/pinning/pinFileToIPFS', {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': Buffer.byteLength(formData, 'binary')
    },
    body: Buffer.from(formData, 'binary'),
    timeout: 120000
  });

  console.log(`📌 Pinned to Pinata: ${result.IpfsHash} (${filename})`);

  return {
    cid: result.IpfsHash,
    name: filename,
    size: result.PinSize,
    timestamp: result.Timestamp,
    gatewayUrl: `${config.pinata.gateway}/${result.IpfsHash}`
  };
}

/**
 * Pin existing CID to Pinata by fetching from local IPFS and uploading
 * (Free plan doesn't support pinByHash, so we fetch and re-upload)
 */
async function pinByHashToPinata(cid, name = '') {
  const config = await loadConfig();

  // Fetch content from local IPFS node
  console.log(`📥 Fetching ${cid} from local IPFS...`);
  const ipfsContent = await new Promise((resolve, reject) => {
    const url = new URL(`/api/v0/cat?arg=${cid}`, config.apiUrl);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, { method: 'POST', timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`Failed to fetch from IPFS: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('IPFS fetch timeout'));
    });
    req.end();
  });

  // Get pin info for metadata
  const pins = await listPins();
  const pinInfo = pins.find(p => p.cid === cid);
  const filename = name || pinInfo?.name || cid;
  const fileType = pinInfo?.type || detectFileType(filename);

  // Build multipart form data for Pinata
  const boundary = '----PinataBoundary' + Date.now();

  const pinataMetadata = JSON.stringify({
    name: filename,
    keyvalues: {
      type: fileType,
      source: 'void-server',
      originalCid: cid
    }
  });

  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="pinataMetadata"\r\n`,
    `Content-Type: application/json\r\n\r\n`,
    pinataMetadata,
    `\r\n--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    `Content-Type: application/octet-stream\r\n\r\n`
  ].join('');

  const ending = `\r\n--${boundary}--\r\n`;

  const formData = Buffer.concat([
    Buffer.from(parts, 'utf8'),
    ipfsContent,
    Buffer.from(ending, 'utf8')
  ]);

  console.log(`📤 Uploading to Pinata (${ipfsContent.length} bytes)...`);

  const result = await pinataRequest('/pinning/pinFileToIPFS', {
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': formData.length
    },
    body: formData,
    timeout: 120000
  });

  console.log(`📌 Pinned to Pinata: ${result.IpfsHash}`);

  // Update local pin registry with Pinata status
  await updatePinPinataStatus(cid, {
    published: true,
    pinataCid: result.IpfsHash,
    timestamp: result.Timestamp
  });

  return {
    success: true,
    cid: result.IpfsHash,
    originalCid: cid,
    name: filename,
    size: result.PinSize,
    timestamp: result.Timestamp,
    gatewayUrl: `${config.pinata.gateway}/${result.IpfsHash}`
  };
}

/**
 * Unpin from Pinata
 */
async function unpinFromPinata(cid) {
  await pinataRequest(`/pinning/unpin/${cid}`, { method: 'DELETE' });
  console.log(`📤 Unpinned from Pinata: ${cid}`);
  return { success: true, cid };
}

/**
 * List pins from Pinata
 */
async function listPinataFiles() {
  const result = await pinataRequest('/data/pinList?status=pinned', { method: 'GET' });
  return result.rows || [];
}

/**
 * Update pin's Pinata status in registry
 */
async function updatePinPinataStatus(cid, pinataData) {
  const content = await fs.readFile(PINS_PATH, 'utf8');
  const data = JSON.parse(content);

  const pin = data.pins.find(p => p.cid === cid);
  if (pin) {
    pin.pinata = pinataData;
    await fs.writeFile(PINS_PATH, JSON.stringify(data, null, 2));
  }

  return pin;
}

module.exports = {
  initialize,
  loadConfig,
  saveConfig,
  checkDaemon,
  checkNatStatus,
  pinFile,
  pinUrl,
  pinDirectory,
  unpin,
  listPins,
  getStatus,
  detectFileType,
  // Pinata
  checkPinata,
  pinFileToPinata,
  pinByHashToPinata,
  unpinFromPinata,
  listPinataFiles,
  updatePinPinataStatus
};
