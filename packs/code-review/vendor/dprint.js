// dprint/package/esm/_dnt.polyfills.js
if (!Object.hasOwn) {
  Object.defineProperty(Object, "hasOwn", {
    value: function(object, property) {
      if (object == null) {
        throw new TypeError("Cannot convert undefined or null to object");
      }
      return Object.prototype.hasOwnProperty.call(Object(object), property);
    },
    configurable: true,
    enumerable: false,
    writable: true
  });
}

// dprint/package/esm/v3.js
var decoder = new TextDecoder();
var encoder = new TextEncoder();
function createHost() {
  let instance;
  let hostFormatter = void 0;
  let overrideConfig = {};
  let filePath = "";
  let formattedText = "";
  let errorText = "";
  return {
    setInstance(wasmInstance) {
      instance = wasmInstance;
    },
    setHostFormatter(formatWithHost) {
      hostFormatter = formatWithHost;
    },
    createImportObject() {
      let sharedBuffer = new Uint8Array(0);
      let sharedBufferIndex = 0;
      const resetSharedBuffer = (length) => {
        sharedBuffer = new Uint8Array(length);
        sharedBufferIndex = 0;
      };
      return {
        dprint: {
          "host_clear_bytes": (length) => {
            resetSharedBuffer(length);
          },
          "host_read_buffer": (pointer, length) => {
            sharedBuffer.set(getWasmBufferAtPointer(instance, pointer, length), sharedBufferIndex);
            sharedBufferIndex += length;
          },
          "host_write_buffer": (pointer, index, length) => {
            getWasmBufferAtPointer(instance, pointer, length).set(sharedBuffer.slice(index, index + length));
          },
          "host_take_file_path": () => {
            filePath = decoder.decode(sharedBuffer);
            resetSharedBuffer(0);
          },
          "host_take_override_config": () => {
            overrideConfig = JSON.parse(decoder.decode(sharedBuffer));
            resetSharedBuffer(0);
          },
          "host_format": () => {
            const fileText = decoder.decode(sharedBuffer);
            try {
              formattedText = hostFormatter?.({
                filePath,
                fileText,
                overrideConfig
              }) ?? fileText;
              return fileText === formattedText ? 0 : 1;
            } catch (error) {
              errorText = String(error);
              return 2;
            }
          },
          "host_get_formatted_text": () => {
            sharedBuffer = encoder.encode(formattedText);
            sharedBufferIndex = 0;
            return sharedBuffer.length;
          },
          "host_get_error_text": () => {
            sharedBuffer = encoder.encode(errorText);
            sharedBufferIndex = 0;
            return sharedBuffer.length;
          }
        }
      };
    }
  };
}
function createFromInstance(wasmInstance, host) {
  host.setInstance(wasmInstance);
  const wasmExports = wasmInstance.exports;
  const { get_plugin_schema_version, set_file_path, set_override_config, get_formatted_text, format, get_error_text, get_plugin_info, get_resolved_config, get_config_diagnostics, set_global_config, set_plugin_config, get_license_text, reset_config } = wasmExports;
  const pluginSchemaVersion = get_plugin_schema_version();
  const expectedPluginSchemaVersion = 3;
  if (pluginSchemaVersion !== 2 && pluginSchemaVersion !== expectedPluginSchemaVersion) {
    throw new Error(`Not compatible plugin. Expected schema ${expectedPluginSchemaVersion}, but plugin had ${pluginSchemaVersion}.`);
  }
  let configSet = false;
  return {
    setConfig(globalConfig, pluginConfig) {
      setConfig(globalConfig, pluginConfig);
    },
    getConfigDiagnostics() {
      setConfigIfNotSet();
      const length = get_config_diagnostics();
      return JSON.parse(receiveString(wasmInstance, length));
    },
    getResolvedConfig() {
      setConfigIfNotSet();
      const length = get_resolved_config();
      return JSON.parse(receiveString(wasmInstance, length));
    },
    getFileMatchingInfo() {
      const length = get_plugin_info();
      const pluginInfo = JSON.parse(receiveString(wasmInstance, length));
      return {
        // deno-lint-ignore no-explicit-any
        fileExtensions: pluginInfo.fileExtensions ?? [],
        // deno-lint-ignore no-explicit-any
        fileNames: pluginInfo.fileNames ?? []
      };
    },
    getPluginInfo() {
      const length = get_plugin_info();
      const pluginInfo = JSON.parse(receiveString(wasmInstance, length));
      delete pluginInfo.fileNames;
      delete pluginInfo.fileExtensions;
      return pluginInfo;
    },
    getLicenseText() {
      const length = get_license_text();
      return receiveString(wasmInstance, length);
    },
    setHostFormatter(formatWithHost) {
      host.setHostFormatter(formatWithHost);
    },
    formatText(request) {
      if (request.bytesRange != null) {
        return request.fileText;
      }
      setConfigIfNotSet();
      if (request.overrideConfig != null) {
        if (pluginSchemaVersion === 2) {
          throw new Error("Cannot set the override configuration for this old plugin.");
        }
        sendString(wasmInstance, JSON.stringify(request.overrideConfig));
        set_override_config();
      }
      sendString(wasmInstance, request.filePath);
      set_file_path();
      sendString(wasmInstance, request.fileText);
      const responseCode = format();
      switch (responseCode) {
        case 0:
          return request.fileText;
        case 1:
          return receiveString(wasmInstance, get_formatted_text());
        case 2:
          throw new Error(receiveString(wasmInstance, get_error_text()));
        default:
          throw new Error(`Unexpected response code: ${responseCode}`);
      }
    }
  };
  function setConfigIfNotSet() {
    if (!configSet) {
      setConfig({}, {});
    }
  }
  function setConfig(globalConfig, pluginConfig) {
    if (reset_config != null) {
      reset_config();
    }
    sendString(wasmInstance, JSON.stringify(globalConfig));
    set_global_config();
    sendString(wasmInstance, JSON.stringify(pluginConfig));
    set_plugin_config();
    configSet = true;
  }
}
function sendString(wasmInstance, text) {
  const exports = wasmInstance.exports;
  const encodedText = encoder.encode(text);
  const length = encodedText.length;
  const memoryBufferSize = exports.get_wasm_memory_buffer_size();
  const memoryBufferPointer = getWasmMemoryBufferPointer(wasmInstance);
  exports.clear_shared_bytes(length);
  let index = 0;
  while (index < length) {
    const writeCount = Math.min(length - index, memoryBufferSize);
    const wasmBuffer = getWasmBufferAtPointer(wasmInstance, memoryBufferPointer, writeCount);
    wasmBuffer.set(encodedText.slice(index, index + writeCount));
    exports.add_to_shared_bytes_from_buffer(writeCount);
    index += writeCount;
  }
  return length;
}
function receiveString(wasmInstance, length) {
  const exports = wasmInstance.exports;
  const memoryBufferSize = exports.get_wasm_memory_buffer_size();
  const memoryBufferPointer = getWasmMemoryBufferPointer(wasmInstance);
  const buffer = new Uint8Array(length);
  let index = 0;
  while (index < length) {
    const readCount = Math.min(length - index, memoryBufferSize);
    exports.set_buffer_with_shared_bytes(index, readCount);
    const wasmBuffer = getWasmBufferAtPointer(wasmInstance, memoryBufferPointer, readCount);
    buffer.set(wasmBuffer, index);
    index += readCount;
  }
  return decoder.decode(buffer);
}
function getWasmMemoryBufferPointer(wasmInstance) {
  return wasmInstance.exports.get_wasm_memory_buffer();
}
function getWasmBufferAtPointer(wasmInstance, pointer, length) {
  return new Uint8Array(
    // deno-lint-ignore no-explicit-any
    wasmInstance.exports.memory.buffer,
    pointer,
    length
  );
}

// dprint/package/esm/_dnt.shims.js
var dntGlobals = {};
var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
function createMergeProxy(baseObj, extObj) {
  return new Proxy(baseObj, {
    get(_target, prop, _receiver) {
      if (prop in extObj) {
        return extObj[prop];
      } else {
        return baseObj[prop];
      }
    },
    set(_target, prop, value) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      baseObj[prop] = value;
      return true;
    },
    deleteProperty(_target, prop) {
      let success = false;
      if (prop in extObj) {
        delete extObj[prop];
        success = true;
      }
      if (prop in baseObj) {
        delete baseObj[prop];
        success = true;
      }
      return success;
    },
    ownKeys(_target) {
      const baseKeys = Reflect.ownKeys(baseObj);
      const extKeys = Reflect.ownKeys(extObj);
      const extKeysSet = new Set(extKeys);
      return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
    },
    defineProperty(_target, prop, desc) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      Reflect.defineProperty(baseObj, prop, desc);
      return true;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in extObj) {
        return Reflect.getOwnPropertyDescriptor(extObj, prop);
      } else {
        return Reflect.getOwnPropertyDescriptor(baseObj, prop);
      }
    },
    has(_target, prop) {
      return prop in extObj || prop in baseObj;
    }
  });
}

// dprint/package/esm/wasi.js
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _PluginMemory_instances;
var _PluginMemory_host;
var _PluginMemory_getView;
var WASI_MODULE_NAME = "wasi_snapshot_preview1";
function createWasiImports(host) {
  const memory = new PluginMemory(host);
  return mapValues({
    // capabilities
    clock_res_get(clockId, resolutionPtr) {
      if (clockNowNanos(clockId) == null) {
        return ERRNO_INVAL;
      }
      memory.writeU64(resolutionPtr, CLOCK_RESOLUTION_NANOS);
      return ERRNO_SUCCESS;
    },
    clock_time_get(clockId, _precision, timePtr) {
      const nanos = clockNowNanos(clockId);
      if (nanos == null) {
        return ERRNO_INVAL;
      }
      memory.writeU64(timePtr, nanos);
      return ERRNO_SUCCESS;
    },
    poll_oneoff(subscriptionsPtr, eventsPtr, subscriptionsLen, eventsLenPtr) {
      const result = readSubscriptions(memory, subscriptionsPtr, subscriptionsLen);
      if (typeof result === "number") {
        return result;
      }
      memory.getBytes(eventsPtr, result.events.length * EVENT_SIZE);
      memory.getBytes(eventsLenPtr, 4);
      if (result.sleepNanos != null) {
        sleep(result.sleepNanos);
      }
      result.events.forEach((event, i) => memory.getBytes((eventsPtr >>> 0) + i * EVENT_SIZE, EVENT_SIZE).set(event));
      memory.writeU32(eventsLenPtr, result.events.length);
      return ERRNO_SUCCESS;
    },
    random_get(bufPtr, bufLen) {
      const buf = memory.getBytes(bufPtr, bufLen);
      const maxLength = 65536;
      for (let i = 0; i < buf.length; i += maxLength) {
        const bytes = new Uint8Array(Math.min(maxLength, buf.length - i));
        crypto.getRandomValues(bytes);
        buf.set(bytes, i);
      }
      return ERRNO_SUCCESS;
    },
    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) {
        return ERRNO_BADF;
      }
      const output = readOutput(memory, iovsPtr, iovsLen);
      if (typeof output === "number") {
        return output;
      }
      memory.getBytes(nwrittenPtr, 4);
      if (output.text.length > 0) {
        host.writeOutput(output.text);
      }
      memory.writeU32(nwrittenPtr, output.written);
      return ERRNO_SUCCESS;
    },
    sched_yield: () => ERRNO_SUCCESS,
    proc_exit(code) {
      throw new Error(`The plugin attempted to exit with code ${code}.`);
    },
    // empty environment
    args_sizes_get: writeTwoZeros,
    args_get: () => ERRNO_SUCCESS,
    environ_sizes_get: writeTwoZeros,
    environ_get: () => ERRNO_SUCCESS,
    // standard streams
    fd_fdstat_get(fd, fdstatPtr) {
      if (!isStdStream(fd)) {
        return ERRNO_BADF;
      }
      const fdstat = memory.getBytes(fdstatPtr, 24);
      fdstat.fill(0);
      fdstat[0] = FILETYPE_CHARACTER_DEVICE;
      memory.writeU64((fdstatPtr >>> 0) + 8, fd === 0 ? RIGHTS_FD_READ : RIGHTS_FD_WRITE);
      return ERRNO_SUCCESS;
    },
    fd_filestat_get(fd, filestatPtr) {
      if (!isStdStream(fd)) {
        return ERRNO_BADF;
      }
      const filestat = memory.getBytes(filestatPtr, 64);
      filestat.fill(0);
      filestat[16] = FILETYPE_CHARACTER_DEVICE;
      return ERRNO_SUCCESS;
    },
    fd_read(fd, _iovsPtr, _iovsLen, nreadPtr) {
      if (fd !== 0) {
        return ERRNO_BADF;
      }
      memory.writeU32(nreadPtr, 0);
      return ERRNO_SUCCESS;
    },
    fd_seek: (fd) => isStdStream(fd) ? ERRNO_SPIPE : ERRNO_BADF,
    fd_close: (fd) => isStdStream(fd) ? ERRNO_SUCCESS : ERRNO_BADF,
    // no file system. Returning "bad file descriptor" from `fd_prestat_get` tells
    // the libc that there are no preopened directories.
    fd_prestat_get: () => ERRNO_BADF,
    fd_prestat_dir_name: () => ERRNO_BADF,
    fd_advise: () => ERRNO_BADF,
    fd_pread: () => ERRNO_BADF,
    fd_readdir: () => ERRNO_BADF,
    path_filestat_get: () => ERRNO_BADF,
    path_open: () => ERRNO_BADF,
    path_readlink: () => ERRNO_BADF,
    path_unlink_file: () => ERRNO_BADF
  }, failOnInvalidMemoryAccess);
  function writeTwoZeros(firstPtr, secondPtr) {
    memory.writeU32(firstPtr, 0);
    memory.writeU32(secondPtr, 0);
    return ERRNO_SUCCESS;
  }
}
function addUnsupportedWasiImports(wasiImports, wasmModule) {
  for (const moduleImport of WebAssembly.Module.imports(wasmModule)) {
    if (moduleImport.module === WASI_MODULE_NAME && moduleImport.kind === "function" && !Object.hasOwn(wasiImports, moduleImport.name)) {
      wasiImports[moduleImport.name] = () => ERRNO_NOSYS;
    }
  }
}
var ERRNO_SUCCESS = 0;
var ERRNO_BADF = 8;
var ERRNO_FAULT = 21;
var ERRNO_INVAL = 28;
var ERRNO_NOSYS = 52;
var ERRNO_SPIPE = 70;
var CLOCK_REALTIME = 0;
var CLOCK_MONOTONIC = 1;
var NANOS_PER_MILLI = 1000000n;
var CLOCK_RESOLUTION_NANOS = NANOS_PER_MILLI;
var EVENTTYPE_CLOCK = 0;
var EVENTTYPE_FD_READ = 1;
var EVENTTYPE_FD_WRITE = 2;
var SUBCLOCKFLAGS_ABSTIME = 1;
var SUBSCRIPTION_SIZE = 48;
var EVENT_SIZE = 32;
var MAX_SUBSCRIPTIONS = 1024;
var FILETYPE_CHARACTER_DEVICE = 2;
var RIGHTS_FD_READ = 1n << 1n;
var RIGHTS_FD_WRITE = 1n << 6n;
var MAX_IOVS = 1024;
var MAX_WRITE_BYTES = 64 * 1024;
var decoder2 = new TextDecoder();
var monotonicStartMillis = performance.now();
var InvalidMemoryAccessError = class extends Error {
};
var PluginMemory = class {
  constructor(host) {
    _PluginMemory_instances.add(this);
    _PluginMemory_host.set(this, void 0);
    __classPrivateFieldSet(this, _PluginMemory_host, host, "f");
  }
  /** Gets a view of the bytes in the memory, where the pointer and length are unsigned 32 bit integers. */
  getBytes(ptr, length) {
    const buffer = __classPrivateFieldGet(this, _PluginMemory_host, "f").getMemory()?.buffer;
    const start = ptr >>> 0;
    const end = start + (length >>> 0);
    if (buffer == null || end > buffer.byteLength) {
      throw new InvalidMemoryAccessError();
    }
    return new Uint8Array(buffer, start, end - start);
  }
  readU16(ptr) {
    return __classPrivateFieldGet(this, _PluginMemory_instances, "m", _PluginMemory_getView).call(this, ptr, 2).getUint16(0, true);
  }
  readU32(ptr) {
    return __classPrivateFieldGet(this, _PluginMemory_instances, "m", _PluginMemory_getView).call(this, ptr, 4).getUint32(0, true);
  }
  readU64(ptr) {
    return __classPrivateFieldGet(this, _PluginMemory_instances, "m", _PluginMemory_getView).call(this, ptr, 8).getBigUint64(0, true);
  }
  writeU32(ptr, value) {
    __classPrivateFieldGet(this, _PluginMemory_instances, "m", _PluginMemory_getView).call(this, ptr, 4).setUint32(0, value, true);
  }
  writeU64(ptr, value) {
    __classPrivateFieldGet(this, _PluginMemory_instances, "m", _PluginMemory_getView).call(this, ptr, 8).setBigUint64(0, value, true);
  }
};
_PluginMemory_host = /* @__PURE__ */ new WeakMap(), _PluginMemory_instances = /* @__PURE__ */ new WeakSet(), _PluginMemory_getView = function _PluginMemory_getView2(ptr, length) {
  const bytes = this.getBytes(ptr, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};
function failOnInvalidMemoryAccess(func) {
  return (...args) => {
    try {
      return func(...args);
    } catch (err) {
      if (err instanceof InvalidMemoryAccessError) {
        return ERRNO_FAULT;
      }
      throw err;
    }
  };
}
function isStdStream(fd) {
  return fd >= 0 && fd <= 2;
}
function clockNowNanos(clockId) {
  switch (clockId) {
    case CLOCK_REALTIME:
      return BigInt(Date.now()) * NANOS_PER_MILLI;
    case CLOCK_MONOTONIC:
      return BigInt(Math.floor(performance.now() - monotonicStartMillis)) * NANOS_PER_MILLI;
    default:
      return void 0;
  }
}
function sleep(nanos) {
  const maxMillis = 2 ** 31 - 1;
  const millis = Number((nanos + NANOS_PER_MILLI - 1n) / NANOS_PER_MILLI);
  if (millis <= 0) {
    return;
  }
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(millis, maxMillis));
  } catch {
  }
}
function readSubscriptions(memory, subscriptionsPtr, subscriptionsLen) {
  subscriptionsLen >>>= 0;
  if (subscriptionsLen === 0 || subscriptionsLen > MAX_SUBSCRIPTIONS) {
    return ERRNO_INVAL;
  }
  const readyEvents = [];
  const timeouts = [];
  for (let i = 0; i < subscriptionsLen; i++) {
    const subscriptionPtr = (subscriptionsPtr >>> 0) + i * SUBSCRIPTION_SIZE;
    const subscription = memory.getBytes(subscriptionPtr, SUBSCRIPTION_SIZE);
    const userData = subscription.slice(0, 8);
    const eventType = subscription[8];
    const id = memory.readU32(subscriptionPtr + 16);
    if (eventType === EVENTTYPE_CLOCK) {
      const timeout2 = memory.readU64(subscriptionPtr + 24);
      const flags = memory.readU16(subscriptionPtr + 40);
      const now = clockNowNanos(id);
      if (now == null) {
        readyEvents.push(createEvent(userData, ERRNO_INVAL, eventType));
      } else if ((flags & SUBCLOCKFLAGS_ABSTIME) !== 0) {
        timeouts.push({ userData, timeout: timeout2 > now ? timeout2 - now : 0n });
      } else {
        timeouts.push({ userData, timeout: timeout2 });
      }
    } else if (eventType === EVENTTYPE_FD_READ || eventType === EVENTTYPE_FD_WRITE) {
      const isValidFd = eventType === EVENTTYPE_FD_READ ? id === 0 : id === 1 || id === 2;
      readyEvents.push(createEvent(userData, isValidFd ? ERRNO_SUCCESS : ERRNO_BADF, eventType));
    } else {
      return ERRNO_INVAL;
    }
  }
  if (readyEvents.length > 0) {
    const elapsedTimeouts = timeouts.filter((t) => t.timeout === 0n);
    return {
      events: [...readyEvents, ...elapsedTimeouts.map((t) => createEvent(t.userData, ERRNO_SUCCESS, EVENTTYPE_CLOCK))],
      sleepNanos: void 0
    };
  }
  const timeout = timeouts.reduce((min, t) => t.timeout < min ? t.timeout : min, timeouts[0].timeout);
  return {
    events: timeouts.filter((t) => t.timeout === timeout).map((t) => createEvent(t.userData, ERRNO_SUCCESS, EVENTTYPE_CLOCK)),
    sleepNanos: timeout
  };
}
function createEvent(userData, errno, eventType) {
  const event = new Uint8Array(EVENT_SIZE);
  event.set(userData, 0);
  new DataView(event.buffer).setUint16(8, errno, true);
  event[10] = eventType;
  return event;
}
function readOutput(memory, iovsPtr, iovsLen) {
  iovsLen >>>= 0;
  if (iovsLen > MAX_IOVS) {
    return ERRNO_INVAL;
  }
  const bytes = new Uint8Array(MAX_WRITE_BYTES);
  let written = 0;
  for (let i = 0; i < iovsLen && written < MAX_WRITE_BYTES; i++) {
    const iovecPtr = (iovsPtr >>> 0) + i * 8;
    const buf = memory.getBytes(memory.readU32(iovecPtr), memory.readU32(iovecPtr + 4));
    const length = Math.min(buf.length, MAX_WRITE_BYTES - written);
    bytes.set(buf.subarray(0, length), written);
    written += length;
  }
  return { text: sanitizeOutput(bytes.subarray(0, written)), written };
}
function sanitizeOutput(bytes) {
  return decoder2.decode(bytes).replaceAll("\r", "").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "\uFFFD");
}
function mapValues(object, map) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value)]));
}

// dprint/package/esm/v4.js
var decoder3 = new TextDecoder();
var encoder2 = new TextEncoder();
function createHost2(options = {}) {
  const writeOutput = options.onOutput ?? writeStderr;
  let instance;
  let hostFormatter = void 0;
  let formattedText = "";
  let errorText = "";
  return {
    setInstance(wasmInstance) {
      instance = wasmInstance;
    },
    setHostFormatter(formatWithHost) {
      hostFormatter = formatWithHost;
    },
    createImportObject(wasmModule) {
      let sharedBuffer = new Uint8Array(0);
      const wasiImports = createWasiImports({
        // the instance isn't set while the module is being instantiated
        getMemory: () => instance?.exports.memory,
        // stdout and stderr are both written to the same place
        writeOutput
      });
      if (wasmModule != null) {
        addUnsupportedWasiImports(wasiImports, wasmModule);
      }
      return {
        env: {
          "fd_write": wasiImports.fd_write
        },
        [WASI_MODULE_NAME]: wasiImports,
        dprint: {
          "host_has_cancelled": () => 0,
          "host_write_buffer": (pointer) => {
            getWasmBufferAtPointer2(instance, pointer, sharedBuffer.length).set(sharedBuffer);
          },
          "host_format": (filePathPtr, filePathLen, rangeStart, rangeEnd, overrideConfigPtr, overrideConfigLen, fileBytesPtr, fileBytesLen) => {
            const filePath = receiveString2(filePathPtr, filePathLen);
            const overrideConfigRaw = receiveString2(overrideConfigPtr, overrideConfigLen);
            const overrideConfig = overrideConfigRaw === "" ? {} : JSON.parse(overrideConfigRaw);
            const fileText = receiveString2(fileBytesPtr, fileBytesLen);
            const bytesRange = rangeStart === 0 && rangeEnd === fileBytesLen ? void 0 : [rangeStart, rangeEnd];
            try {
              formattedText = hostFormatter?.({
                filePath,
                fileText,
                bytesRange,
                overrideConfig
              }) ?? fileText;
              return fileText === formattedText ? 0 : 1;
            } catch (error) {
              errorText = String(error);
              return 2;
            }
          },
          "host_get_formatted_text": () => {
            sharedBuffer = encoder2.encode(formattedText);
            return sharedBuffer.length;
          },
          "host_get_error_text": () => {
            sharedBuffer = encoder2.encode(errorText);
            return sharedBuffer.length;
          }
        }
      };
    }
  };
  function receiveString2(ptr, length) {
    return decoder3.decode(getWasmBufferAtPointer2(instance, ptr, length));
  }
}
function createFromInstance2(wasmInstance, host) {
  host.setInstance(wasmInstance);
  const configId = 1;
  const wasmExports = wasmInstance.exports;
  initializeWasiReactor(wasmExports);
  const { get_shared_bytes_ptr, set_file_path, set_override_config, clear_shared_bytes, get_formatted_text, format, format_range, get_error_text, get_plugin_info, get_config_file_matching, get_resolved_config, get_config_diagnostics, get_license_text, register_config, release_config } = wasmExports;
  let configSet = false;
  return {
    setConfig(globalConfig, pluginConfig) {
      setConfig(globalConfig, pluginConfig);
    },
    getConfigDiagnostics() {
      setConfigIfNotSet();
      const length = get_config_diagnostics(configId);
      return JSON.parse(receiveString2(length));
    },
    getResolvedConfig() {
      setConfigIfNotSet();
      const length = get_resolved_config(configId);
      return JSON.parse(receiveString2(length));
    },
    getFileMatchingInfo() {
      const length = get_config_file_matching(configId);
      return JSON.parse(receiveString2(length));
    },
    getPluginInfo() {
      const length = get_plugin_info();
      return JSON.parse(receiveString2(length));
    },
    getLicenseText() {
      const length = get_license_text();
      return receiveString2(length);
    },
    setHostFormatter(formatWithHost) {
      host.setHostFormatter(formatWithHost);
    },
    formatText(request) {
      if (request.bytesRange != null && format_range == null) {
        return request.fileText;
      }
      setConfigIfNotSet();
      if (request.overrideConfig != null) {
        sendString2(JSON.stringify(request.overrideConfig));
        set_override_config();
      }
      sendString2(request.filePath);
      set_file_path();
      sendString2(request.fileText);
      const responseCode = request.bytesRange != null ? format_range(configId, request.bytesRange[0], request.bytesRange[1]) : format(configId);
      switch (responseCode) {
        case 0:
          return request.fileText;
        case 1:
          return receiveString2(get_formatted_text());
        case 2:
          throw new Error(receiveString2(get_error_text()));
        default:
          throw new Error(`Unexpected response code: ${responseCode}`);
      }
    }
  };
  function setConfigIfNotSet() {
    if (!configSet) {
      setConfig({}, {});
    }
  }
  function setConfig(globalConfig, pluginConfig) {
    release_config(configId);
    sendString2(JSON.stringify({
      global: globalConfig,
      plugin: pluginConfig
    }));
    register_config(configId);
    configSet = true;
  }
  function sendString2(value) {
    const bytes = encoder2.encode(value);
    const ptr = clear_shared_bytes(bytes.length);
    getWasmBufferAtPointer2(wasmInstance, ptr, bytes.length).set(bytes);
  }
  function receiveString2(length) {
    const ptr = get_shared_bytes_ptr();
    return decoder3.decode(getWasmBufferAtPointer2(wasmInstance, ptr, length));
  }
}
function writeStderr(text) {
  try {
    dntGlobalThis.process?.stderr.write(text);
  } catch {
  }
}
function initializeWasiReactor(wasmExports) {
  if (typeof wasmExports._initialize === "function") {
    wasmExports._initialize();
  } else if (wasmExports._start != null) {
    throw new Error("The plugin was built as a WASI command (it exports _start), but it must be built as a WASI reactor (exporting _initialize).");
  }
}
function getWasmBufferAtPointer2(wasmInstance, pointer, length) {
  return new Uint8Array(
    // deno-lint-ignore no-explicit-any
    wasmInstance.exports.memory.buffer,
    pointer,
    length
  );
}

// dprint/package/esm/mod.js
function createContext(globalConfig = {}, options) {
  const plugins = [];
  function findPluginForFile(filePath) {
    const fileName = getFileName(filePath);
    const ext = getFileExtension(filePath);
    for (const plugin of plugins) {
      if (plugin.fileNames.has(fileName)) {
        return plugin;
      }
    }
    if (ext) {
      for (const plugin of plugins) {
        if (plugin.fileExtensions.has(ext)) {
          return plugin;
        }
      }
    }
    return void 0;
  }
  function createHostFormatter(currentPlugin) {
    return (request) => {
      const plugin = findPluginForFile(request.filePath);
      if (plugin && plugin !== currentPlugin) {
        return plugin.formatter.formatText(request);
      }
      return request.fileText;
    };
  }
  return {
    async addPluginStreaming(source, pluginConfig) {
      const wasmModule = await createWasmModuleFromStreaming(source);
      return this.addPlugin(wasmModule, pluginConfig);
    },
    addPlugin(source, pluginConfig = {}) {
      const formatter = source instanceof WebAssembly.Module ? createFromWasmModule(source, options) : createFromBuffer(source, options);
      formatter.setConfig(globalConfig, pluginConfig);
      const matchingInfo = formatter.getFileMatchingInfo();
      const fileExtensions = new Set(matchingInfo.fileExtensions.map((ext) => ext.toLowerCase()));
      const fileNames = new Set(matchingInfo.fileNames.map((name) => name.toLowerCase()));
      const registered = {
        formatter,
        pluginConfig,
        fileExtensions,
        fileNames
      };
      plugins.push(registered);
      formatter.setHostFormatter(createHostFormatter(registered));
      return {
        formatText(request) {
          return formatter.formatText(request);
        },
        getResolvedConfig() {
          return formatter.getResolvedConfig();
        },
        getConfigDiagnostics() {
          return formatter.getConfigDiagnostics();
        }
      };
    },
    formatText(request) {
      const plugin = findPluginForFile(request.filePath);
      if (!plugin) {
        throw new Error(`No plugin found for file: ${request.filePath}. Registered plugins handle: ${plugins.map((p) => [...p.fileExtensions].join(", ")).join("; ")}`);
      }
      return plugin.formatter.formatText(request);
    },
    getConfigDiagnostics() {
      return plugins.flatMap((p) => p.formatter.getConfigDiagnostics());
    }
  };
}
function getFileName(filePath) {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return (lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath).toLowerCase();
}
function getFileExtension(filePath) {
  const fileName = getFileName(filePath);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot > 0) {
    return fileName.slice(lastDot + 1);
  }
  return void 0;
}
async function createStreaming(responsePromise, options) {
  const wasmModule = await createWasmModuleFromStreaming(responsePromise);
  return createFromWasmModule(wasmModule, options);
}
async function createWasmModuleFromStreaming(responsePromise) {
  const response = await responsePromise;
  if (response.status !== 200) {
    throw new Error(`Unexpected status code: ${response.status}
${await response.text()}`);
  }
  if (typeof WebAssembly.instantiateStreaming === "function" && response.headers.get("content-type") === "application/wasm") {
    return await WebAssembly.compileStreaming(response);
  } else {
    return response.arrayBuffer().then((buffer) => new WebAssembly.Module(buffer));
  }
}
function createFromBuffer(wasmModuleBuffer, options) {
  const wasmModule = new WebAssembly.Module(wasmModuleBuffer);
  return createFromWasmModule(wasmModule, options);
}
function createFromWasmModule(wasmModule, options) {
  const version = getModuleVersionOrThrow(wasmModule);
  if (version === 3) {
    const host = createHost();
    const wasmInstance = new WebAssembly.Instance(wasmModule, host.createImportObject());
    return createFromInstance(wasmInstance, host);
  } else {
    const _assert4 = version;
    const host = createHost2(options);
    const wasmInstance = new WebAssembly.Instance(wasmModule, host.createImportObject(wasmModule));
    return createFromInstance2(wasmInstance, host);
  }
}
function getModuleVersionOrThrow(module) {
  const version = getModuleVersion(module);
  if (version == null) {
    throw new Error("Couldn't determine dprint plugin version. Maybe the js-formatter version is too old?");
  } else if (version === 3 || version === 4) {
    return version;
  } else if (version > 4) {
    throw new Error(`Unsupported new dprint plugin version '${version}'. Maybe the js-formatter version is too old?`);
  } else {
    throw new Error(`Unsupported old dprint plugin version '${version}'. Please upgrade the plugin.`);
  }
}
function getModuleVersion(module) {
  function getVersionFromExport(name) {
    if (name === "get_plugin_schema_version") {
      return 3;
    }
    const prefix = "dprint_plugin_version_";
    if (name.startsWith(prefix)) {
      const value = parseInt(name.substring(prefix.length), 10);
      if (!isNaN(value)) {
        return value;
      }
    }
    return void 0;
  }
  const exports = WebAssembly.Module.exports(module);
  for (const e of exports) {
    const maybeVersion = getVersionFromExport(e.name);
    if (maybeVersion != null) {
      return maybeVersion;
    }
  }
  return void 0;
}
export {
  createContext,
  createFromBuffer,
  createFromWasmModule,
  createStreaming
};
