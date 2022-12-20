/*jshint esversion: 6 */
/* globals process */
const nThen = require("nthen");
const getFolderSize = require("get-folder-size");
const Util = require("../common-util");
const Ulimit = require("ulimit");
const Decrees = require("../decrees");
const Pinning = require("./pin-rpc");
const Core = require("./core");
const Channel = require("./channel");
const BlockStore = require("../storage/block");

var Fs = require("fs");

var Admin = module.exports;

var getFileDescriptorCount = function (Env, server, cb) {
    Fs.readdir('/proc/self/fd', function(err, list) {
        if (err) { return void cb(err); }
        cb(void 0, list.length);
    });
};

var getFileDescriptorLimit = function (env, server, cb) {
    Ulimit(cb);
};

var getCacheStats = function (env, server, cb) {
    var metaSize = 0;
    var channelSize = 0;
    var metaCount = 0;
    var channelCount = 0;

    try {
        var meta = env.metadata_cache;
        for (var x in meta) {
            if (meta.hasOwnProperty(x)) {
                metaCount++;
                metaSize += JSON.stringify(meta[x]).length;
            }
        }

        var channels = env.channel_cache;
        for (var y in channels) {
            if (channels.hasOwnProperty(y)) {
                channelCount++;
                channelSize += JSON.stringify(channels[y]).length;
            }
        }
    } catch (err) {
        return void cb(err && err.message);
    }

    cb(void 0, {
        metadata: metaCount,
        metaSize: metaSize,
        channel: channelCount,
        channelSize: channelSize,
        memoryUsage: process.memoryUsage(),
    });
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_WORKER_PROFILES'], console.log)
var getWorkerProfiles = function (Env, Server, cb) {
    cb(void 0, Env.commandTimers);
};

var getActiveSessions = function (Env, Server, cb) {
    var stats = Server.getSessionStats();
    cb(void 0, [
        stats.total,
        stats.unique
    ]);
};

var shutdown = function (Env, Server, cb) {
    if (true) {
        return void cb('E_NOT_IMPLEMENTED');
    }

    // disconnect all users and reject new connections
    Server.shutdown();

    // stop all intervals that may be running
    Object.keys(Env.intervals).forEach(function (name) {
        clearInterval(Env.intervals[name]);
    });

    // set a flag to prevent incoming database writes
    // wait until all pending writes are complete
    // then process.exit(0);
    // and allow system functionality to restart the server
};

var getRegisteredUsers = function (Env, Server, cb) {
    Env.batchRegisteredUsers('', cb, function (done) {
        var dir = Env.paths.pin;
        var folders;
        var users = 0;
        nThen(function (waitFor) {
            Fs.readdir(dir, waitFor(function (err, list) {
                if (err) {
                    waitFor.abort();
                    return void done(err);
                }
                folders = list;
            }));
        }).nThen(function (waitFor) {
            folders.forEach(function (f) {
                var dir = Env.paths.pin + '/' + f;
                Fs.readdir(dir, waitFor(function (err, list) {
                    if (err) { return; }
                    users += list.length;
                }));
            });
        }).nThen(function () {
            done(void 0, users);
        });
    });
};

var getDiskUsage = function (Env, Server, cb) {
    Env.batchDiskUsage('', cb, function (done) {
        var data = {};
        nThen(function (waitFor) {
            getFolderSize('./', waitFor(function(err, info) {
                data.total = info;
            }));
            getFolderSize(Env.paths.pin, waitFor(function(err, info) {
                data.pin = info;
            }));
            getFolderSize(Env.paths.blob, waitFor(function(err, info) {
                data.blob = info;
            }));
            getFolderSize(Env.paths.staging, waitFor(function(err, info) {
                data.blobstage = info;
            }));
            getFolderSize(Env.paths.block, waitFor(function(err, info) {
                data.block = info;
            }));
            getFolderSize(Env.paths.data, waitFor(function(err, info) {
                data.datastore = info;
            }));
        }).nThen(function () {
            done(void 0, data);
        });
    });
};

var getActiveChannelCount = function (Env, Server, cb) {
    cb(void 0, Server.getActiveChannelCount());
};

var flushCache = function (Env, Server,  cb) {
    Env.flushCache();
    cb(void 0, true);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['ARCHIVE_DOCUMENT', documentID], console.log)
var archiveDocument = function (Env, Server, cb, data) {
    if (!Array.isArray(data)) { return void cb("EINVAL"); }
    var args = data[1];

    var id, reason;
    if (typeof(args) === 'string') {
        id = args;
    } else if (args && typeof(args) === 'object') {
        id = args.id;
        reason = args.reason;
    }

    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    switch (id.length) {
        case 32:
            return void Env.msgStore.archiveChannel(id, Util.both(cb, function (err) {
                Env.Log.info("ARCHIVAL_CHANNEL_BY_ADMIN_RPC", {
                    channelId: id,
                    reason: reason,
                    status: err? String(err): "SUCCESS",
                });
                Channel.disconnectChannelMembers(Env, Server, id, 'EDELETED', err => {
                    if (err) { } // TODO
                });
            }));
        case 48:
            return void Env.blobStore.archive.blob(id, Util.both(cb, function (err) {
                Env.Log.info("ARCHIVAL_BLOB_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err? String(err): "SUCCESS",
                });
            }));
        default:
            return void cb("INVALID_ID_LENGTH");
    }

    // archival for blob proofs isn't automated, but evict-inactive.js will
    // clean up orpaned blob proofs
    // Env.blobStore.archive.proof(userSafeKey, blobId, cb)
};

var removeDocument = function (Env, Server, cb, data) {
    if (!Array.isArray(data)) { return void cb("EINVAL"); }
    var args = data[1];

    var id, reason;
    if (typeof(args) === 'string') {
        id = args;
    } else if (args && typeof(args) === 'object') {
        id = args.id;
        reason = args.reason;
    }

    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    switch (id.length) {
        case 32:
            return void Env.msgStore.removeChannel(id, Util.both(cb, function (err) {
                Env.Log.info("REMOVAL_CHANNEL_BY_ADMIN_RPC", {
                    channelId: id,
                    reason: reason,
                    status: err? String(err): "SUCCESS",
                });
                Channel.disconnectChannelMembers(Env, Server, id, 'EDELETED', err => {
                    if (err) { } // TODO
                });
            }));
        case 48:
            return void Env.blobStore.remove.blob(id, Util.both(cb, function (err) {
                Env.Log.info("REMOVAL_BLOB_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err? String(err): "SUCCESS",
                });
            }));
        default:
            return void cb("INVALID_ID_LENGTH");
    }
};


var restoreArchivedDocument = function (Env, Server, cb, data) {
    if (!Array.isArray(data)) { return void cb("EINVAL"); }
    var args = data[1];

    var id, reason;
    if (typeof(args) === 'string') {
        id = args;
    } else if (args && typeof(args) === 'object') {
        id = args.id;
        reason = args.reason;
    }

    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    switch (id.length) {
        case 32:
            return void Env.msgStore.restoreArchivedChannel(id, Util.both(cb, function (err) {
                Env.Log.info("RESTORATION_CHANNEL_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err? String(err): 'SUCCESS',
                });
            }));
        case 48:
            // FIXME this does not yet restore blob ownership
            // Env.blobStore.restore.proof(userSafekey, id, cb)
            return void Env.blobStore.restore.blob(id, Util.both(cb, function (err) {
                Env.Log.info("RESTORATION_BLOB_BY_ADMIN_RPC", {
                    id: id,
                    reason: reason,
                    status: err? String(err): 'SUCCESS',
                });
            }));
        default:
            return void cb("INVALID_ID_LENGTH");
    }
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['CLEAR_CACHED_CHANNEL_INDEX', documentID], console.log)
var clearChannelIndex = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }
    delete Env.channel_cache[id];
    cb();
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_CACHED_CHANNEL_INDEX', documentID], console.log)
var getChannelIndex = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    var index = Util.find(Env, ['channel_cache', id]);
    if (!index) { return void cb("ENOENT"); }
    cb(void 0, index);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['CLEAR_CACHED_CHANNEL_METADATA', documentID], console.log)
var clearChannelMetadata = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }
    delete Env.metadata_cache[id];
    cb();
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_CACHED_CHANNEL_METADATA', documentID], console.log)
var getChannelMetadata = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string' || id.length < 32) { return void cb("EINVAL"); }

    var index = Util.find(Env, ['metadata_cache', id]);
    if (!index) { return void cb("ENOENT"); }
    cb(void 0, index);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', [ 'ADMIN_DECREE', ['RESTRICT_REGISTRATION', [true]]], console.log)
var adminDecree = function (Env, Server, cb, data, unsafeKey) {
    var value = data[1];
    if (!Array.isArray(value)) { return void cb('INVALID_DECREE'); }

    var command = value[0];
    var args = value[1];

/*

The admin should have sent a command to be run:

the server adds two pieces of information to the supplied decree:

* the unsafeKey of the admin who uploaded it
* the current time

1. test the command to see if it's valid and will result in a change
2. if so, apply it and write it to the log for persistence
3. respond to the admin with an error or nothing

*/

    var decree = [command, args, unsafeKey, +new Date()];
    var changed;
    try {
        changed = Decrees.handleCommand(Env, decree) || false;
    } catch (err) {
        return void cb(err);
    }

    if (!changed) { return void cb(); }
    Env.Log.info('ADMIN_DECREE', decree);
    Decrees.write(Env, decree, cb);
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['SET_LAST_EVICTION', 0], console.log)
var setLastEviction = function (Env, Server, cb, data, unsafeKey) {
    var time = data && data[1];
    if (typeof(time) !== 'number') {
        return void cb('INVALID_ARGS');
    }

    Env.lastEviction = time;
    cb();
    Env.Log.info('LAST_EVICTION_TIME_SET', {
        author: unsafeKey,
        time: time,
    });
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['INSTANCE_STATUS], console.log)
var instanceStatus = function (Env, Server, cb) {
    cb(void 0, {
        restrictRegistration: Env.restrictRegistration,
        enableEmbedding: Env.enableEmbedding,
        launchTime: Env.launchTime,
        currentTime: +new Date(),

        inactiveTime: Env.inactiveTime,
        accountRetentionTime: Env.accountRetentionTime,
        archiveRetentionTime: Env.archiveRetentionTime,

        defaultStorageLimit: Env.defaultStorageLimit,

        lastEviction: Env.lastEviction,
        evictionReport: Env.evictionReport,

        disableIntegratedEviction: Env.disableIntegratedEviction,
        disableIntegratedTasks: Env.disableIntegratedTasks,

        enableProfiling: Env.enableProfiling,
        profilingWindow: Env.profilingWindow,

        maxUploadSize: Env.maxUploadSize,
        premiumUploadSize: Env.premiumUploadSize,

        consentToContact: Env.consentToContact,
        listMyInstance: Env.listMyInstance,
        provideAggregateStatistics: Env.provideAggregateStatistics,

        removeDonateButton: Env.removeDonateButton,
        blockDailyCheck: Env.blockDailyCheck,

        updateAvailable: Env.updateAvailable,
        instancePurpose: Env.instancePurpose,

        instanceDescription: Env.instanceDescription,
        instanceJurisdiction: Env.instanceJurisdiction,
        instanceName: Env.instanceName,
        instanceNotice: Env.instanceNotice,
    });
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_LIMITS'], console.log)
var getLimits = function (Env, Server, cb) {
    cb(void 0, Env.limits);
};

var isValidKey = key => {
    return typeof(key) === 'string' && key.length === 44;
};

// CryptPad_AsyncStore.rpc.send('ADMIN', ['GET_USER_TOTAL_SIZE', "CrufexqXcY/z+eKJlEbNELVy5Sb7E/EAAEFI8GnEtZ0="], console.log)
var getUserTotalSize = function (Env, Server, cb, data) {
    var signingKey = Array.isArray(data) && data[1];
    if (!isValidKey(signingKey)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(signingKey);
    Pinning.getTotalSize(Env, safeKey, cb);
};

var getPinActivity = function (Env, Server, cb, data) {
    var signingKey = Array.isArray(data) && data[1];
    if (!isValidKey(signingKey)) { return void cb("EINVAL"); }
    // the db-worker ensures the signing key is of the appropriate form
    Env.getPinActivity(signingKey, function (err, response) {
        if (err) { return void cb(err && err.code); }
        cb(void 0, response);
    });
};

var isUserOnline = function (Env, Server, cb, data) {
    var key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    key = Util.unescapeKeyCharacters(key);
    var online = false;
    try {
        Object.keys(Env.netfluxUsers).some(function (netfluxId) {
            if (!Env.netfluxUsers[netfluxId][key]) { return; }
            online = true;
            return true;
        });
    } catch (err) {
        Env.Log.error('ADMIN_USER_ONLINE_CHECK', {
            error: err,
            key: key,
        });
        return void cb("SERVER_ERROR");
    }
    cb(void 0, online);
};

var getPinLogStatus = function (Env, Server, cb, data) {
    var key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(key);

    var response = {};
    nThen(function (w) {
        Env.pinStore.isChannelAvailable(safeKey, w(function (err, result) {
            if (err) {
                return void Env.Log.error('PIN_LOG_STATUS_AVAILABLE', err);
            }
            response.live = result;
        }));
        Env.pinStore.isChannelArchived(safeKey, w(function (err, result) {
            if (err) {
                return void Env.Log.error('PIN_LOG_STATUS_ARCHIVED', err);
            }
            response.archived = result;
        }));
    }).nThen(function () {
        cb(void 0, response);
    });
};

var getDocumentStatus = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (typeof(id) !== 'string') { return void cb("EINVAL"); }
    var response = {};
    if (id.length === 44) {
        return void nThen(function (w) {
            BlockStore.isAvailable(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_AVAILABLE', err);
                }
                response.live = result;
            }));
            BlockStore.isArchived(Env, id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOCK_STATUS_ARCHIVED', err);
                }
                response.archived = result;
            }));
        }).nThen(function () {
            cb(void 0, response);
        });
    }
    if (id.length === 48) {
        return void nThen(function (w) {
            Env.blobStore.isBlobAvailable(id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOB_STATUS_AVAILABLE', err);
                }
                response.live = result;
            }));
            Env.blobStore.isBlobArchived(id, w(function (err, result) {
                if (err) {
                    return void Env.Log.error('BLOB_STATUS_ARCHIVED', err);
                }
                response.archived = result;
            }));
        }).nThen(function () {
            cb(void 0, response);
        });
    }
    if (id.length !== 32) { return void cb("EINVAL"); }
    nThen(function (w) {
        Env.store.isChannelAvailable(id, w(function (err, result) {
            if (err) {
                return void Env.Log.error('CHANNEL_STATUS_AVAILABLE', err);
            }
            response.live = result;
        }));
        Env.store.isChannelArchived(id, w(function (err, result) {
            if (err) {
                return void Env.Log.error('CHANNEL_STATUS_ARCHIVED', err);
            }
            response.archived = result;
        }));
    }).nThen(function () {
        cb(void 0, response);
    });
};

var getPinList = function (Env, Server, cb, data) {
    var key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(key);

    Env.getPinState(safeKey, function (err, value) {
        if (err) { return void cb(err); }
        try {
            return void cb(void 0, Object.keys(value).filter(k => value[k]));
        } catch (err2) { }
        cb("UNEXPECTED_SERVER_ERROR");
    });
};

var getPinHistory = function (Env, Server, cb, data) {
    Env.Log.debug('GET_PIN_HISTORY', data);
    cb("NOT_IMPLEMENTED");
};

var archivePinLog = function (Env, Server, cb, data) {
    var args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    var key = args.key;
    var reason = args.reason || '';
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(key);

    Env.pinStore.archiveChannel(safeKey, function (err) {
        Core.expireSession(Env.Sessions, safeKey);
        if (err) {
            Env.Log.error('ARCHIVE_PIN_LOG_BY_ADMIN', {
                error: err,
                safeKey: safeKey,
                reason: reason,
            });
        } else {
            Env.Log.info('ARCHIVE_PIN_LOG_BY_ADMIN', {
                safeKey: safeKey,
                reason: reason,
            });
        }
        cb(err);
    });
};

var archiveBlock = function (Env, Server, cb, data) {
    var args = Array.isArray(data) && data[1];
    if (!args) { return void cb("INVALID_ARGS"); }
    var key = args.key;
    var reason = args.reason;
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    BlockStore.archive(Env, key, err => {
        Env.Log.info("ARCHIVE_BLOCK_BY_ADMIN", {
            error: err,
            key: key,
            reason: reason || '',
        });
        cb(err);
    });
};

var restoreArchivedBlock = function (Env, Server, cb, data) {
    var args = Array.isArray(data) && data[1];
    if (!args) { return void cb("INVALID_ARGS"); }
    var key = args.key;
    var reason = args.reason;
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    BlockStore.restore(Env, key, err => {
        Env.Log.info("RESTORE_ARCHIVED_BLOCK_BY_ADMIN", {
            error: err,
            key: key,
            reason: reason || '',
        });
        cb(err);
    });
};

var restoreArchivedPinLog = function (Env, Server, cb, data) {
    var args = Array.isArray(data) && data[1];
    if (!args || typeof(args) !== 'object') { return void cb("EINVAL"); }
    var key = args.key;
    var reason = args.reason || '';
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(key);
    Env.pinStore.restoreArchivedChannel(safeKey, function (err) {
        Core.expireSession(Env.Sessions, safeKey);
        if (err) {
            Env.Log.error("RESTORE_ARCHIVED_PIN_LOG_BY_ADMIN", {
                error: err,
                safeKey: safeKey,
                reason: reason,
            });
        } else {
            Env.Log.info('RESTORE_ARCHIVED_PIN_LOG_BY_ADMIN', {
                safeKey: safeKey,
                reason: reason,
            });
        }
        cb(err);
    });
};

var archiveOwnedDocuments = function (Env, Server, cb, data) {
    Env.Log.debug('ARCHIVE_OWNED_DOCUMENTS', data);
    cb("NOT_IMPLEMENTED");
};

// quotas...
var getUserQuota = function (Env, Server, cb, data) {
    var key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    Pinning.getLimit(Env, key, cb);
};

var getUserStorageStats = function (Env, Server, cb, data) {
    var key = Array.isArray(data) && data[1];
    if (!isValidKey(key)) { return void cb("EINVAL"); }
    var safeKey = Util.escapeKeyCharacters(key);

    Env.getPinState(safeKey, function (err, value) {
        if (err) { return void cb(err); }
        try {
            var res = {
                channels: 0,
                files: 0,
            };
            Object.keys(value).forEach(k => {
                switch (k.length) {
                    case 32: return void ((res.channels++));
                    case 48: return void ((res.files++));
                }
            });
            return void cb(void 0, res);
        } catch (err2) { }
        cb("UNEXPECTED_SERVER_ERROR");
    });
};

var getStoredMetadata = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Env.computeMetadata(id, function (err, data) {
        cb(err, data);
    });
};

var getDocumentSize = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Env.getFileSize(id, (err, size) => {
        if (err) { return void cb(err); }
        cb(err, size);
    });
};

var getLastChannelTime = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }
    Env.getLastChannelTime(id, function (err, time) {
        if (err) { return void cb(err && err.code); }
        cb(err, time);
    });
};

var getMetadataHistory = function (Env, Server, cb, data) {
    var id = Array.isArray(data) && data[1];
    if (!Core.isValidId(id)) { return void cb('INVALID_CHAN'); }

    var lines = [];
    Env.msgStore.readChannelMetadata(id, (err, line) => {
        if (err) { return; }
        lines.push(line);
    }, err => {
        if (err) {
            Env.Log.error('ADMIN_GET_METADATA_HISTORY', {
                error: err,
                id: id,
            });
            return void cb(err);
        }
        cb(void 0, lines);
    });
};

var commands = {
    ACTIVE_SESSIONS: getActiveSessions,
    ACTIVE_PADS: getActiveChannelCount,
    REGISTERED_USERS: getRegisteredUsers,
    DISK_USAGE: getDiskUsage,
    FLUSH_CACHE: flushCache,
    SHUTDOWN: shutdown,
    GET_FILE_DESCRIPTOR_COUNT: getFileDescriptorCount,
    GET_FILE_DESCRIPTOR_LIMIT: getFileDescriptorLimit,
    GET_CACHE_STATS: getCacheStats,

    GET_PIN_ACTIVITY: getPinActivity,
    IS_USER_ONLINE: isUserOnline,
    GET_USER_QUOTA: getUserQuota,
    GET_USER_STORAGE_STATS: getUserStorageStats,
    GET_PIN_LOG_STATUS: getPinLogStatus,

    GET_METADATA_HISTORY: getMetadataHistory,
    GET_STORED_METADATA: getStoredMetadata,
    GET_DOCUMENT_SIZE: getDocumentSize,
    GET_LAST_CHANNEL_TIME: getLastChannelTime,
    GET_DOCUMENT_STATUS: getDocumentStatus,

    GET_PIN_LIST: getPinList,
    GET_PIN_HISTORY: getPinHistory,
    ARCHIVE_PIN_LOG: archivePinLog,
    ARCHIVE_OWNED_DOCUMENTS: archiveOwnedDocuments,
    RESTORE_ARCHIVED_PIN_LOG: restoreArchivedPinLog,

    ARCHIVE_BLOCK: archiveBlock,
    RESTORE_ARCHIVED_BLOCK: restoreArchivedBlock,

    ARCHIVE_DOCUMENT: archiveDocument,
    RESTORE_ARCHIVED_DOCUMENT: restoreArchivedDocument,

    CLEAR_CACHED_CHANNEL_INDEX: clearChannelIndex,
    GET_CACHED_CHANNEL_INDEX: getChannelIndex,
    // TODO implement admin historyTrim
    // TODO implement kick from channel
    // TODO implement force-disconnect user(s)?

    CLEAR_CACHED_CHANNEL_METADATA: clearChannelMetadata,
    GET_CACHED_CHANNEL_METADATA: getChannelMetadata,

    ADMIN_DECREE: adminDecree,
    INSTANCE_STATUS: instanceStatus,
    GET_LIMITS: getLimits,
    SET_LAST_EVICTION: setLastEviction,
    GET_WORKER_PROFILES: getWorkerProfiles,
    GET_USER_TOTAL_SIZE: getUserTotalSize,

    REMOVE_DOCUMENT: removeDocument,
};

// addFirstAdmin is an anon_rpc command
Admin.addFirstAdmin = function (Env, data, cb) {
    var token = data.token;
    if (token !== Env.installToken) { return void cb('FORBIDDEN'); }
    if (Array.isArray(Env.admins) && Env.admins.length) { return void cb('EEXISTS'); }

    var key = data.edPublic;
    if (token.length !== 64 || data.edPublic.length !== 44) { return void cb('INVALID_ARGS'); }

    adminDecree(Env, null, cb, ['ADD_FIRST_ADMIN', [
        'ADD_ADMIN_KEY',
        [key]
    ]], "");
};

Admin.command = function (Env, safeKey, data, _cb, Server) {
    var cb = Util.once(Util.mkAsync(_cb));

    var admins = Env.admins;

    var unsafeKey = Util.unescapeKeyCharacters(safeKey);
    if (admins.indexOf(unsafeKey) === -1) {
        return void cb("FORBIDDEN");
    }

    var command = commands[data[0]];

    if (typeof(command) === 'function') {
        return void command(Env, Server, cb, data, unsafeKey);
    }

    return void cb('UNHANDLED_ADMIN_COMMAND');
};

