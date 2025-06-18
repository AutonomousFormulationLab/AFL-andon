const { Client } = require('ssh2');
const fs = require('fs').promises;
const path = require('path');

const DEBUG_SSH = ['1', 'true', 'yes'].includes(
  (process.env.DEBUG_SSH || '').toLowerCase()
);
const debugLog = (...args) => {
  if (DEBUG_SSH) {
    console.log('[SSH DEBUG]', ...args);
  }
};

class SSHOperations {
  constructor(configPath, sshKeyPath) {
    this.config = {};
    this.sshKeyPath = sshKeyPath;
    this.configPath = configPath;
    this.screenSessionCache = {}; // Cache for screen sessions by host
  }

  async initialize() {
    await this.loadConfig();
    await this.loadSSHKey();
  }

  async loadConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      // Set default values if not specified
      Object.keys(this.config).forEach(serverName => {
        const server = this.config[serverName];
        if (!server.httpPort) server.httpPort = 5000;
        if (!server.shell) server.shell = 'bash';
        if (!('active' in server)) server.active = true;
        if (!server.username) {
          console.warn(`Username not specified for server ${serverName}. Using current user.`);
          server.username = require('os').userInfo().username;
        }
      });
    } catch (error) {
      console.error('Error loading config:', error);
    }
  }
  async saveConfig() {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving config:', error);
      throw error;
    }
  }

  async loadSSHKey() {
    try {
      this.sshKey = await fs.readFile(this.sshKeyPath);
    } catch (error) {
      console.error('Error loading SSH key:', error);
    }
  }

  setConfigPath(newPath) {
    this.configPath = newPath;
  }

  setSshKeyPath(newPath) {
    this.sshKeyPath = newPath;
  }
  addServer(serverName, serverConfig) {
    this.config[serverName] = serverConfig;
  }

  removeServer(serverName) {
    delete this.config[serverName];
  }

  updateServer(serverName, serverConfig) {
    this.config[serverName] = { ...this.config[serverName], ...serverConfig };
  }

  toggleServerActive(serverName) {
    if (this.config[serverName]) {
      this.config[serverName].active = !this.config[serverName].active;
    }
  }

  async executeCommand(serverName, command, timeout = 0) {
    return new Promise((resolve) => {
      const serverConfig = this.config[serverName];
      if (!serverConfig) {
        resolve({ success: false, sshDown: true });
        return;
      }

      debugLog(`${serverName} -> ${serverConfig.host}: ${command}`);

      const conn = new Client();
      let timer;
      let settled = false;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      conn.on('ready', () => {
        debugLog(`${serverName}: connection ready`);
        cleanup();
        debugLog(`${serverName}: executing \"${command}\"`);
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            if (!settled) {
              settled = true;
              resolve({ success: false, sshDown: true });
            }
            return;
          }

          let output = '';
          stream.on('close', (code, signal) => {
            conn.end();
            debugLog(`${serverName}: command finished with code ${code}`);
            if (!settled) {
              settled = true;
              resolve({ success: true, output, code, signal });
            }
            debugLog(`${serverName}: output length ${output.length}`);
          }).on('data', (data) => {
            output += data;
          }).stderr.on('data', (data) => {
            output += data;
          });
        });
      }).on('error', (err) => {
        cleanup();
        debugLog(`${serverName}: connection error`, err.message);
        console.error(`SSH connection error for ${serverName}:`, err);
        if (!settled) {
          settled = true;
          resolve({ success: false, sshDown: true });
        }
      });

      debugLog(`${serverName}: connecting to ${serverConfig.host}`);
      conn.connect({
        host: serverConfig.host,
        port: 22,
        username: serverConfig.username,
        privateKey: this.sshKey
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          console.warn(`SSH connection timed out for ${serverName}`);
          debugLog(`${serverName}: timeout after ${timeout}ms`);
          conn.destroy();
          cleanup();
          if (!settled) {
            settled = true;
            resolve({ success: false, sshDown: true });
          }
        }, timeout);
      }
    });
  }

  async startServer(serverName) {
    const serverConfig = this.config[serverName];
    const screenLogPath = path.join('.afl', `${serverConfig.screen_name}.screenlog`);
    let startCommand;

    if (serverConfig.server_module) {
      let command = `python -m ${serverConfig.server_module}`;
      if (serverConfig.conda_env) {
        command = `conda activate ${serverConfig.conda_env};${command}`;
      }
      startCommand = `screen -d -m -L -Logfile $\{HOME}/${screenLogPath} -S ${serverConfig.screen_name} ${serverConfig.shell} -ci "${command}"`;
    } else if (serverConfig.server_script) {
      startCommand = `screen -d -m -L -Logfile $\{HOME}/${screenLogPath} -S ${serverConfig.screen_name} ${serverConfig.server_script}`;
    } else {
      return { success: false, error: 'Neither server_module nor server_script specified in config' };
    }

    return this.executeCommand(serverName, startCommand);
  }

  async stopServer(serverName) {
    const serverConfig = this.config[serverName];
    const stopCommand = `screen -X -S ${serverConfig.screen_name} quit`;
    return this.executeCommand(serverName, stopCommand);
  }

  async restartServer(serverName) {
    const stopResult = await this.stopServer(serverName);
    if (!stopResult.success && !stopResult.sshDown) {
      return stopResult;
    }
    return this.startServer(serverName);
  }

  async getServerStatus(serverName) {
    const serverConfig = this.config[serverName];

    debugLog(`Checking status for ${serverName} on ${serverConfig.host}`);
    
    // Use the cached screen sessions if they exist for this host and are recent
    const host = serverConfig.host;
    const cachedData = this.screenSessionCache && this.screenSessionCache[host];
    const now = Date.now();
    
    if (cachedData && (now - cachedData.timestamp) < 5000) { // Cache valid for 5 seconds
      return {
        success: true,
        status: cachedData.sessions.includes(serverConfig.screen_name)
      };
    }
    
    const statusCommand = 'screen -ls';
    const result = await this.executeCommand(serverName, statusCommand, 500);

    if (!result.success) {
      return { success: false, sshDown: true };
    }
    
    // Parse and cache all screen sessions for this host
    if (!this.screenSessionCache) {
      this.screenSessionCache = {};
    }
    
    // Extract all session names from the screen -ls output
    const screenSessions = [];
    const lines = result.output.split('\n');
    for (const line of lines) {
      // Look for lines containing screen session info
      const match = line.match(/\d+\.([^\s\t]+)/); // Extracts session name
      if (match && match[1]) {
        screenSessions.push(match[1]);
      }
    }
    
    // Cache the results
    this.screenSessionCache[host] = {
      timestamp: now,
      sessions: screenSessions
    };

    debugLog(
      `${serverName}: sessions on ${host} -> ${screenSessions.join(', ')}`
    );
    
    return {
      success: true,
      status: screenSessions.includes(serverConfig.screen_name)
    };
  }

  // Get status for all servers on a given host in one call
  async getBatchServerStatus(host) {
    // Find a server from this host to execute the command
    const serverName = Object.keys(this.config).find(name =>
      this.config[name].host === host
    );
    
    if (!serverName) {
      return { success: false, error: `No server configured for host ${host}` };
    }
    
    debugLog(`Batch status for host ${host} using ${serverName}`);
    const statusCommand = 'screen -ls';
    const result = await this.executeCommand(serverName, statusCommand, 500);
    
    if (!result.success) {
      return { success: false, sshDown: true, host };
    }
    
    // Extract all session names from the screen -ls output
    const screenSessions = [];
    const lines = result.output.split('\n');
    for (const line of lines) {
      const match = line.match(/\d+\.([^\s\t]+)/); // Extracts session name
      if (match && match[1]) {
        screenSessions.push(match[1]);
      }
    }
    
    // Cache the results
    const now = Date.now();
    if (!this.screenSessionCache) {
      this.screenSessionCache = {};
    }
    this.screenSessionCache[host] = {
      timestamp: now,
      sessions: screenSessions
    };
    debugLog(`Host ${host} sessions: ${screenSessions.join(', ')}`);
    
    return { success: true, host, sessions: screenSessions };
  }
  
  // Group all servers by host for efficient batch checking
  getServersByHost() {
    const hostMap = {};
    
    Object.entries(this.config).forEach(([serverName, serverConfig]) => {
      if (!serverConfig.active) return;
      
      const host = serverConfig.host;
      if (!hostMap[host]) {
        hostMap[host] = [];
      }
      hostMap[host].push(serverName);
    });
    
    return hostMap;
  }
  
  async getServerLog(serverName, lines = 200) {
    const serverConfig = this.config[serverName];
    const logPath = path.join('.afl', `${serverConfig.screen_name}.screenlog`);
    const logCommand = `tail -n ${lines} $\{HOME}/${logPath}`;
    return this.executeCommand(serverName, logCommand);
  }

  async joinServer(serverName) {
    const serverConfig = this.config[serverName];
    const joinCommand = `screen -x ${serverConfig.screen_name}`;
    return this.executeCommand(serverName, joinCommand);
  }

  getServerForHost(host) {
    const entry = Object.entries(this.config).find(([, cfg]) => cfg.host === host);
    if (!entry) return null;
    return entry[1];
  }

  async readRemoteFile(host, remotePath) {
    const server = this.getServerForHost(host);
    if (!server) return { success: false, error: `No server for host ${host}` };
    return new Promise((resolve) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            resolve({ success: false, error: err.message });
            return;
          }
          sftp.readFile(remotePath, 'utf8', (err, data) => {
            conn.end();
            if (err) resolve({ success: false, error: err.message });
            else resolve({ success: true, data });
          });
        });
      }).on('error', (err) => {
        resolve({ success: false, error: err.message });
      }).connect({
        host: server.host,
        port: 22,
        username: server.username,
        privateKey: this.sshKey
      });
    });
  }

  async writeRemoteFile(host, remotePath, content) {
    const server = this.getServerForHost(host);
    if (!server) return { success: false, error: `No server for host ${host}` };
    return new Promise((resolve) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            resolve({ success: false, error: err.message });
            return;
          }
          const dir = path.posix.dirname(remotePath);
          sftp.mkdir(dir, { mode: 0o755 }, () => {
            sftp.writeFile(remotePath, content, 'utf8', (err2) => {
              conn.end();
              if (err2) resolve({ success: false, error: err2.message });
              else resolve({ success: true });
            });
          });
        });
      }).on('error', (err) => {
        resolve({ success: false, error: err.message });
      }).connect({
        host: server.host,
        port: 22,
        username: server.username,
        privateKey: this.sshKey
      });
    });
  }

  async getRemoteAflConfig(host) {
    const server = this.getServerForHost(host);
    if (!server) return { success: false, error: `No server for host ${host}` };
    const remotePath = `/home/${server.username}/.afl/config.json`;
    const res = await this.readRemoteFile(host, remotePath);
    if (!res.success) return res;
    try {
      return { success: true, data: JSON.parse(res.data) };
    } catch (_) {
      return { success: true, data: {} };
    }
  }

  async saveRemoteAflConfig(host, cfgObj) {
    const server = this.getServerForHost(host);
    if (!server) return { success: false, error: `No server for host ${host}` };
    const remotePath = `/home/${server.username}/.afl/config.json`;
    let existing = {};
    const read = await this.readRemoteFile(host, remotePath);
    if (read.success && read.data) {
      try { existing = JSON.parse(read.data); } catch (_) {}
    }
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const micros = String(now.getMilliseconds() * 1000).padStart(6, '0');
    const ts = `${String(now.getFullYear()).slice(-2)}/${pad(now.getDate())}/${pad(now.getMonth() + 1)} ` +
               `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${micros}`;
    existing[ts] = cfgObj;
    const content = JSON.stringify(existing, null, 2);
    return await this.writeRemoteFile(host, remotePath, content);
  }
}

module.exports = SSHOperations;
