/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
  return new (P || (P = Promise))(function (resolve, reject) {
    function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
    function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
    function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const rimraf = require("rimraf");
const chromeFinder = require("./chrome-finder");
const random_port_1 = require("./random-port");
const flags_1 = require("./flags");
const utils_1 = require("./utils");
const log = require('lighthouse-logger');
const spawn = childProcess.spawn;
const execSync = childProcess.execSync;
const isWsl = utils_1.getPlatform() === 'wsl';
const isWindows = utils_1.getPlatform() === 'win32';
const _SIGINT = 'SIGINT';
//const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32', 'wsl']);
const instances = new Set();
const sigintListener = () => __awaiter(this, void 0, void 0, function* () {
  for (const instance of instances) {
    try {
      yield instance.kill();
    }
    catch (err) {
      void 0;
    }
  }
});
async function launch(opts = {}) {
  const common = await import("../../../common.js");
  const {DEBUG} = common;
  return __awaiter(this, void 0, void 0, function* () {
    opts.handleSIGINT = utils_1.defaults(opts.handleSIGINT, true);
    const instance = new Launcher(opts);
    // Kill spawned Chrome process in case of ctrl-C.
    if (opts.handleSIGINT && instances.size === 0) {
      process.on(_SIGINT, sigintListener);
    }
    instances.add(instance);
    yield instance.launch();
    /* eslint-disable require-yield */
    const kill = () => __awaiter(this, void 0, void 0, function* () {
      instances.delete(instance);
      if (instances.size === 0) {
        process.removeListener(_SIGINT, sigintListener);
      }
      return instance.kill();
    });
    /* eslint-ensable require-yield */
    if ( DEBUG.allowExternalChrome ) {
      // we just shim the pids etc (and they become useless) as we can't easily obtain a 
      // process object for an already running process
      // if a chrome is already running
      return { pid: instance.pid || process.pid, port: instance.port, kill, process: instance.chrome || process };
    } else {
      return { pid: instance.pid, port: instance.port, kill, process: instance.chrome };
    }
  });
}
exports.launch = launch;
class Launcher {
  constructor(opts = {}, moduleOverrides = {}) {
    this.opts = opts;
    this.tmpDirandPidFileReady = false;
    this.fs = moduleOverrides.fs || fs;
    this.rimraf = moduleOverrides.rimraf || rimraf;
    this.spawn = moduleOverrides.spawn || spawn;
    log.setLevel(utils_1.defaults(this.opts.logLevel, 'silent'));
    // choose the first one (default)
    this.startingUrl = utils_1.defaults(this.opts.startingUrl, 'about:blank');
    this.chromeFlags = utils_1.defaults(this.opts.chromeFlags, []);
    this.requestedPort = utils_1.defaults(this.opts.port, 0);
    this.chromePath = this.opts.chromePath;
    this.ignoreDefaultFlags = utils_1.defaults(this.opts.ignoreDefaultFlags, false);
    this.connectionPollInterval = utils_1.defaults(this.opts.connectionPollInterval, 500);
    this.maxConnectionRetries = utils_1.defaults(this.opts.maxConnectionRetries, 50);
    this.envVars = utils_1.defaults(opts.envVars, Object.assign({}, process.env));
    if (typeof this.opts.userDataDir === 'boolean') {
      if (!this.opts.userDataDir) {
        this.useDefaultProfile = true;
        this.userDataDir = undefined;
      }
      else {
        throw new utils_1.InvalidUserDataDirectoryError();
      }
    }
    else {
      this.useDefaultProfile = false;
      this.userDataDir = this.opts.userDataDir;
    }
  }
  get flags() {
    const flags = this.ignoreDefaultFlags ? [] : flags_1.DEFAULT_FLAGS.slice();
    flags.push(`--remote-debugging-port=${this.port}`);
    if (!this.ignoreDefaultFlags && utils_1.getPlatform() === 'linux') {
      flags.push('--disable-setuid-sandbox');
    }
    if (!this.useDefaultProfile) {
      // Place Chrome profile in a custom location we'll rm -rf later
      // If in WSL, we need to use the Windows format
      flags.push(`--user-data-dir=${isWsl ? utils_1.toWinDirFormat(this.userDataDir) : this.userDataDir}`);
    }
    flags.push(...this.chromeFlags);
    flags.push(this.startingUrl);
    return flags;
  }
  static defaultFlags() {
    return flags_1.DEFAULT_FLAGS.slice();
  }
  static getFirstInstallation() {
    if (utils_1.getPlatform() === 'darwin')
      return chromeFinder.darwinFast();
    return chromeFinder[utils_1.getPlatform()]()[0];
  }
  static getInstallations() {
    return chromeFinder[utils_1.getPlatform()]();
  }
  // Wrapper function to enable easy testing.
  makeTmpDir() {
    return utils_1.makeTmpDir();
  }
  prepare() {
    const platform = utils_1.getPlatform();
    if (!_SUPPORTED_PLATFORMS.has(platform)) {
      throw new utils_1.UnsupportedPlatformError();
    }
    this.userDataDir = this.userDataDir || this.makeTmpDir();
    this.outFile = this.fs.openSync(`${this.userDataDir}/chrome-out.log`, 'a');
    this.errFile = this.fs.openSync(`${this.userDataDir}/chrome-err.log`, 'a');
    // fix for Node4
    // you can't pass a fd to fs.writeFileSync
    this.pidFile = `${this.userDataDir}/chrome.pid`;
    log.verbose('ChromeLauncher', `created ${this.userDataDir}`);
    this.tmpDirandPidFileReady = true;
  }
  async launch() {
    if (this.requestedPort !== 0) {
      this.port = this.requestedPort;
      // If an explict port is passed first look for an open connection...
      try {
        return await this.isDebuggerReady();
      }
      catch (err) {
        log.log('ChromeLauncher', `No debugging port found on port ${this.port}, launching a new Chrome.`);
      }
    }
    if (this.chromePath === undefined) {
      const installations = Launcher.getInstallations();
      if (installations.length === 0) {
        throw new utils_1.ChromeNotInstalledError();
      }
      this.chromePath = installations[0];
    }
    if (!this.tmpDirandPidFileReady) {
      this.prepare();
    }
    this.pid = await this.spawnProcess(this.chromePath);
  }
  async spawnProcess(execPath) {
    const {DEBUG, CONFIG} = await import("../../../common.js");
    if (this.chrome) {
      log.log('ChromeLauncher', `Chrome already running with pid ${this.chrome.pid}.`);
      return this.chrome.pid;
    }
    // If a zero value port is set, it means the launcher
    // is responsible for generating the port number.
    // We do this here so that we can know the port before
    // we pass it into chrome.
    if (this.requestedPort === 0) {
      this.port = await random_port_1.getRandomPort();
    }
    log.verbose('ChromeLauncher', `Launching with command:\n"${execPath}" ${this.flags.join(' ')}`);
    const script = `#!/bin/bash
    exec ${process.env.BB_POOL ? 'sudo -g browsers ' : ''}"${execPath}" ${this.flags.join(' ')}
    `
    console.log({script});
    const scriptPath = path.resolve(CONFIG.baseDir, 'scripts', 'startc.sh'); 
    fs.mkdirSync(path.dirname(scriptPath), {recursive: true});
    fs.writeFileSync(scriptPath, script);
    fs.chmodSync(scriptPath, 0o777);
    const chrome = this.spawn(scriptPath, { detached: true, stdio: DEBUG.val ? 'inherit' : ['ignore', this.outFile, this.errFile], env: this.envVars });
    this.chrome = chrome;
    DEBUG.val && console.log(this.chrome);
    this.fs.writeFileSync(this.pidFile, chrome.pid.toString());
    log.verbose('ChromeLauncher', `Chrome running with pid ${chrome.pid} on port ${this.port}.`);
    const pid = chrome.pid;
    await this.waitUntilReady();
    return pid;
  }
  cleanup(client) {
    if (client) {
      client.removeAllListeners();
      client.end();
      client.destroy();
      client.unref();
    }
  }
  // resolves if ready, rejects otherwise
  async isDebuggerReady() {
    const {DEBUG, CONFIG} = await import("../../../common.js");
    const port = parseInt(this.port);
    console.log({port});
    let browser;
    try {
      browser = execSync(`curl -s http://localhost:${port}/json/version`);
      console.log('browser', browser.toString());
    } catch(e) {
      DEBUG.val && console.info("Browser error", e);
      throw e;
    }
    DEBUG.val && console.info("Browser OK");
    return browser;
  }
  // resolves when debugger is ready, rejects after 10 polls
  async waitUntilReady() {
    const {sleep} = await import("../../../common.js");
    const launcher = this;
    let retries = 0;
    let waitStatus = 'Waiting for browser.';
    const poll = async () => {
      if (retries === 0) {
        log.log('ChromeLauncher', waitStatus);
      }
      retries++;
      waitStatus += '..';
      log.log('ChromeLauncher', waitStatus);
      try {
        await launcher.isDebuggerReady()
        log.log('ChromeLauncher', waitStatus + `${log.greenify(log.tick)}`);
      } catch(err) {
        if (retries > launcher.maxConnectionRetries) {
          log.error('ChromeLauncher', err);
          const stderr = this.fs.readFileSync(`${this.userDataDir}/chrome-err.log`, { encoding: 'utf-8' });
          log.error('ChromeLauncher', `Logging contents of ${this.userDataDir}/chrome-err.log`);
          log.error('ChromeLauncher', stderr);
          throw err;
        }
        await sleep(launcher.connectionPollInterval);
        poll();
      }
    };
    return await poll();
  }
  kill() {
    return new Promise((resolve, reject) => {
      if (this.chrome) {
        this.chrome.on('close', () => {
          delete this.chrome;
          this.destroyTmp().then(resolve);
        });
        log.log('ChromeLauncher', `Killing Chrome instance ${this.chrome.pid}`);
        try {
          if (isWindows) {
            // While pipe is the default, stderr also gets printed to process.stderr
            // if you don't explicitly set `stdio`
            execSync(`taskkill /pid ${this.chrome.pid} /T /F`, { stdio: 'pipe' });
          }
          else {
            process.kill(-this.chrome.pid);
          }
        }
        catch (err) {
          const message = `Chrome could not be killed ${err.message}`;
          log.warn('ChromeLauncher', message);
          reject(new Error(message));
        }
      }
      else {
        // fail silently as we did not start chrome
        resolve();
      }
    });
  }
  destroyTmp() {
    return new Promise(resolve => {
      // Only clean up the tmp dir if we created it.
      if (this.userDataDir === undefined || this.opts.userDataDir !== undefined) {
        return resolve();
      }
      if (this.outFile) {
        this.fs.closeSync(this.outFile);
        delete this.outFile;
      }
      if (this.errFile) {
        this.fs.closeSync(this.errFile);
        delete this.errFile;
      }
      this.rimraf(this.userDataDir, () => resolve());
    });
  }
}
exports.Launcher = Launcher;

exports.default = Launcher;
