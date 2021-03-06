/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * lib/server/stor/moray_local.js: a stor that falls back to using the local
 *                                 stor only if moray is unreachable.
 */

var assert = require('assert-plus');
var vasync = require('vasync');
var util = require('../../common/util');

module.exports = MorayLocalStorage;

function MorayLocalStorage(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.buckets, 'opts.buckets');
    assert.object(opts.moray, 'opts.moray');
    assert.object(opts.local, 'opts.local');

    self.log = opts.log;
    self.moray = opts.moray;
    self.local = opts.local;
    self.buckets = opts.buckets;
    self.refreshInterval = 60 * 60 * 1000; // One hour
    self.interval = null;
}

// -- Helpers

function is500(err) {
    // All names that we consider "internal errors".  If we're missing
    // one, get the stack trace, which should look like:
    //    first of 1 error: connect ECONNREFUSED
    //    ...
    //    Caused by: Error: connect ECONNREFUSED
    //               ^^^^^ <-- Is what should be in the list below
    var names = [
        'NoConnectionError',     // Moray HA Proxy is down
        'ConnectionClosedError', // Moray services are down
        'PoolClosedError',       // Postgres is down
        'Error',         // Postgres is down
        'error'                  // ZK is down
    ];
    while (err && err.cause && err.cause()) {
        err = err.cause();
    }
    return (names.indexOf(err.name) !== -1);
}

function findHistory(uuid, cb) {
    var self = this;
    var b = self.buckets;
    self.moray.getObject(b.history, uuid, cb);
}

function findApplication(uuid, cb) {
    var self = this;
    var b = self.buckets;
    var app;

    var funcs = [
        function getInstance(_, subcb) {
            function onGet(err, instance) {
                _.instance = instance;
                return (subcb(err));
            }
            self.moray.getObject(b.instances, uuid, onGet);
        },
        function getService(_, subcb) {
            function onGet(err, service) {
                _.service = service;
                return (subcb(err));
            }
            var suuid = _.instance.value.service_uuid;
            self.moray.getObject(b.services, suuid, onGet);
        },
        function getApplication(_, subcb) {
            function onGet(err, application) {
                app = application;
                return (subcb(err));
            }
            var auuid = _.service.value.application_uuid;
            self.moray.getObject(b.applications, auuid, onGet);
        }
    ];

    vasync.pipeline({
        'arg': {},
        'funcs': funcs
    }, function (err) {
        return (cb(err, app));
    });
}

function loadAppObjects(uuid, stor, cb) {
    var self = this;
    var b = self.buckets;

    var arg = {};
    var funcs = [
        function fHistory(_, subcb) {
            stor.listObjectValues(b.history, {}, {},
                function (err, items) {
                _.history = items;
                return (subcb(err));
            });
        },
        function findApp(_, subcb) {
            stor.getObject(b.applications, uuid, function (err, a) {
                _.application = a;
                // Makes things "easier" later...
                _.applications = [];
                if (a) {
                    _.applications.push(a.value);
                }
                return (subcb(err));
            });
        },
        // Find all services
        function findServices(_, subcb) {
            if (!_.application) {
                _.services = [];
                return (subcb());
            }
            var f = {
                'application_uuid': _.application.value.uuid
            };
            function onFind(err, services) {
                _.services = services;
                return (subcb(err));
            }
            stor.listObjectValues(b.services, f, {}, onFind);
        },
        // Find all instances
        function findInstances(_, subcb) {
            var inputs = _.services.map(function (s) {
                return ({
                    'service_uuid': s.uuid
                });
            });
            function fServices(filter, fcb) {
                stor.listObjectValues(b.instances, filter,
                              {}, fcb);
            }
            vasync.forEachParallel({
                'inputs': inputs,
                'func': fServices
            }, function (err, res) {
                var ins = [];
                ins = ins.concat.apply(ins, res.successes);
                _.instances = ins;
                return (subcb(err));
            });
        },
        // Find all manifests
        function findManifests(_, subcb) {
            function extractManifests(a) {
                var uuids = [];
                a.map(function (o) {
                    if (!o.manifests) {
                        return;
                    }
                    var us = Object.keys(o.manifests).map(
                        function (k) {
                            return (o.manifests[k]);
                        });
                    us.forEach(function (u) {
                        if (uuids.indexOf(u) === -1) {
                            uuids.push(u);
                        }
                    });
                });
                return (uuids);
            }
            var muuids = [];
            muuids = muuids.concat(
                extractManifests(_.applications),
                extractManifests(_.services),
                extractManifests(_.instances));
            function fManifests(u, mcb) {
                stor.getObject(b.manifests, u, mcb);
            }
            vasync.forEachParallel({
                'inputs': muuids,
                'func': fManifests
            }, function (err, res) {
                _.manifests = res.successes.map(function (m) {
                    return (m.value);
                });
                return (subcb(err));
            });
        }
    ];

    vasync.pipeline({
        'arg': arg,
        'funcs': funcs
    }, function (err) {
        return (cb(err, arg));
    });

}

function refreshLocal(cb) {
    var self = this;
    var log = self.log;

    log.info('refreshing local stor from moray...');

    var funcs = [
        function getZone(_, subcb) {
            util.zonename(function (err, zonename) {
                if (err) {
                    return (subcb(err));
                }
                _.zonename = zonename;
                return (subcb());
            });
        },
        // Find "my" application
        function findApp(_, subcb) {
            function onFind(err, application) {
                if (err) {
                    return (subcb(err));
                }
                _.application = application;
                return (subcb());
            }
            findApplication.call(self, _.zonename, onFind);
        },
        // Find all "moray" objects
        function findMorayObjects(_, subcb) {
            function onLoad(err, objs) {
                if (err) {
                    return (subcb(err));
                }
                _.moray = objs;
                return (subcb());
            }
            loadAppObjects.call(self, _.application.key,
                        self.moray, onLoad);
        },
        // Find all "local" objects
        function findLocalObjects(_, subcb) {
            function onLoad(err, objs) {
                if (err) {
                    return (subcb(err));
                }
                _.local = objs;
                return (subcb());
            }
            loadAppObjects.call(self, _.application.key,
                        self.local, onLoad);
        },
        // Load everything from moray to local
        function loadInLocal(_, subcb) {
            function putLocal(type, obj, pcb) {
                if (!obj.uuid) {
                    var m = 'obj doesn\'t have a uuid.';
                    log.error({
                        'type': type,
                        'obj': obj
                    }, m);
                    return (pcb(new Error(m)));
                }
                var b = self.buckets[type];
                var k = obj.uuid;
                self.local.putObject(b, k, obj, {}, pcb);
            }
            function morayToLocal(type, mtolcb) {
                vasync.forEachPipeline({
                    'inputs': _.moray[type],
                    'func': function (o, fcb) {
                        putLocal(type, o, fcb);
                    }
                }, mtolcb);
            }
            var types = ['applications', 'instances', 'services',
                     'manifests', 'history' ];
            vasync.forEachPipeline({
                'inputs': types,
                'func': morayToLocal
            }, subcb);
        },
        // Delete any local data that wasn't in moray
        function removeFromLocal(_, subcb) {
            function uuids(a) {
                return (a.map(function (o) {
                    return (o.uuid);
                }));
            }
            function delLocal(type, uuid, dcb) {
                var b = self.buckets[type];
                self.local.delObject(b, uuid, dcb);
            }
            function purgeUnknown(type, pcb) {
                var lus = uuids(_.local[type]);
                var mus = uuids(_.moray[type]);
                var toDelete = [];
                lus.forEach(function (u) {
                    if (mus.indexOf(u) === -1) {
                        toDelete.push(u);
                    }
                });
                vasync.forEachPipeline({
                    'inputs': toDelete,
                    'func': function (o, fcb) {
                        delLocal(type, o, fcb);
                    }
                }, pcb);
            }
            // We leave the manifests alone since extra manifests
            // shouldn't hurt.
            var types = ['instances', 'services', 'history' ];
            vasync.forEachPipeline({
                'inputs': types,
                'func': purgeUnknown
            }, subcb);
        }
    ];

    vasync.pipeline({
        'arg': {},
        'funcs': funcs
    }, function (err) {
        if (err) {
            self.log.error(err, 'error during refresh');
        } else {
            self.log.info('local stor refresh complete');
        }
        if (cb) {
            return (cb(err));
        }
    });
}

// -- Object operations

MorayLocalStorage.prototype.init = function init(cb) {
    var self = this;
    refreshLocal.call(self, function (err) {
        if (err) {
            self.log.error(err, 'err on first refresh');
        }
        self.interval = setInterval(refreshLocal.bind(self),
                        self.refreshInterval);
        if (cb) {
            return (cb(err));
        }
    });
};


MorayLocalStorage.prototype.putObject = putObject;

function putObject(bucket, uuid, obj, opts, cb) {
    var self = this;

    // Put to both places, if moray fails, it's OK it doesn't get written
    // to local.  If the local fails, it'll be refreshed at the next
    // refresh period.
    vasync.pipeline({
        'funcs': [
            function putMoray(_, subcb) {
                self.moray.putObject(bucket, uuid, obj,
                        opts, subcb);
            },
            function putLocal(_, subcb) {
                function onRes(err) {
                    return (subcb());
                }
                self.local.putObject(bucket, uuid, obj,
                        opts, onRes);
            }
        ]
    }, cb);
}

MorayLocalStorage.prototype.getObject = function getObject(bucket, uuid, cb) {
    var self = this;

    // Try to read from moray.  If it fails due to being unavailable, then
    // we try to read from local.
    self.moray.getObject(bucket, uuid, function (err, obj) {
        if (!err || !is500(err)) {
            return (cb(err, obj));
        }
        self.local.getObject(bucket, uuid, function (err2, obj2) {
            if (err2 || !obj2) {
                // Return the original moray err.
                return (cb(err));
            }
            self.log.error(err, 'Failed to fetch from moray but ' +
                       'succeeded from local storage.  Is ' +
                       'moray down?');
            return (cb(null, obj2));
        });
    });
};

MorayLocalStorage.prototype.delObject = function delObject(bucket, uuid, cb) {
    var self = this;

    // Delete from both places.  If the local fails, it'll be resolved at
    // refresh time.
    vasync.pipeline({
        'funcs': [
            function delMoray(_, subcb) {
                self.moray.delObject(bucket, uuid, subcb);
            },
            function delLocal(_, subcb) {
                function onRes(err) {
                    return (subcb());
                }
                self.local.delObject(bucket, uuid, onRes);
            }
        ]
    }, cb);
};

MorayLocalStorage.prototype.listObjectValues = listObjectValues;

function listObjectValues(bucket, filters, opts, cb) {
    var self = this;

    // Try to read from moray.  If it fails due to being unavailable, then
    // we try to read from local.
    self.moray.listObjectValues(bucket, filters, opts, function (err, os) {
        if (!err || !is500(err)) {
            return (cb(err, os));
        }
        function onRes(err2, objs) {
            if (err2 || !objs || objs.length === 0) {
                // Return the original moray err.
                return (cb(err));
            }
            self.log.error(err, 'Failed to fetch from moray but ' +
                       'succeeded from local storage.  Is ' +
                       'moray down?');
            return (cb(null, objs));
        }
        self.local.listObjectValues(bucket, filters, opts, onRes);
    });
}

MorayLocalStorage.prototype.sync = function refresh(cb) {
    var self = this;
    refreshLocal.call(self, cb);
};

MorayLocalStorage.prototype.ping = function ping(cb) {
    var self = this;
    self.moray.ping(function (err) {
        if (err) {
            return (cb(err));
        }
        self.local.ping(cb);
    });
};

MorayLocalStorage.prototype.close = function close() {
    var self = this;
    if (self.interval) {
        clearInterval(self.interval);
    }
    self.moray.close();
    self.local.close();
};
