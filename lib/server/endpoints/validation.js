/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * lib/server/endpoints/validation.js: SAPI endpoint paramter validation
 */

var assert = require('assert-plus');
var restify = require('restify');


function validateParamsAndSendError(opts) {
    var req = opts.req;
    var res = opts.res;
    var keys = opts.keys;
    var params = opts.params;
    var next = opts.next;

    assert.object(req, 'opts.req');
    assert.object(res, 'opts.res');
    assert.object(keys, 'opts.keys');
    assert.object(params, 'opts.params');
    assert.func(next, 'opts.next');

    var missing = keys.filter(function (k) {
        return (!params.hasOwnProperty(k) ||
                  typeof (params[k]) === 'undefined');
    });

    if (missing.length) {
        next(new restify.MissingParameterError(
            'missing required keys: %s', missing.join(', ')));
    }

    return (missing.length !== 0);
}

module.exports = {
    validateParamsAndSendError: validateParamsAndSendError
};
