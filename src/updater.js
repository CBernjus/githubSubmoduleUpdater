const fs = require('fs');
const { Octokit } = require('@octokit/rest');
const { Webhooks } = require('@octokit/webhooks');
const { format } = require('path');

// Logger
const logfile = require('simple-node-logger').createRollingFileLogger({
    logDirectory: 'log',
    fileNamePattern: '<DATE>.log',
    dateFormat: 'YYYY-MM-DD',
});

// Config
const config = JSON.parse(fs.readFileSync('src/config.json'));
const submodules = config.submodules;
const submoduleRepos = submodules.map((module) => module.moduleRepo);

/*
    GITHUB REST API CALLS
*/

const octokit = new Octokit({
    auth: config.auth,
    userAgent: 'submoduleUpdater v1.0',
});

async function getParentHEAD(submodule) {
    return octokit.repos
        .getBranch({
            owner: config.owner,
            repo: submodule.parentRepo,
            branch: submodule.parentBranch,
        })
        .then(({ data: branch }) => {
            log(
                `Fetched current HEAD (${branch.commit.sha}) on branch '${submodule.parentBranch}'`,
                submodule.parentRepo
            );
            logDebug(branch.commit);

            return branch.commit;
        });
}

async function createTree(submodule, moduleSHA, parentTreeSHA) {
    return octokit.git
        .createTree({
            owner: config.owner,
            repo: submodule.parentRepo,
            base_tree: parentTreeSHA,
            tree: [
                {
                    path: submodule.modulePath,
                    mode: '160000',
                    type: 'commit',
                    sha: moduleSHA,
                },
            ],
        })
        .then(({ data: tree }) => {
            log(`Created tree (${tree.sha}) for commit (${moduleSHA})`, submodule.parentRepo);
            logDebug(tree);

            return tree;
        });
}

async function createCommit(submodule, treeSHA, moduleSHA, parentSHA) {
    return octokit.git
        .createCommit({
            owner: config.owner,
            repo: submodule.parentRepo,
            message: `auto-update submodule ${config.owner}/${submodule.moduleRepo} to (${moduleSHA})`,
            tree: treeSHA,
            parents: [parentSHA],
        })
        .then(({ data: commit }) => {
            log(
                `Created commit (${commit.sha}) for module ${submodule.moduleRepo} with tree (${treeSHA})`,
                submodule.parentRepo
            );
            logDebug(commit);

            return commit;
        });
}

async function updateRef(submodule, commitSHA) {
    return octokit.git
        .updateRef({
            owner: config.owner,
            ref: `heads/${submodule.parentBranch}`,
            repo: submodule.parentRepo,
            sha: commitSHA,
        })
        .then(({ data: edit }) => {
            log(`Edit refs and added commit (${commitSHA})`, submodule.parentRepo);
            logDebug(edit);

            return edit;
        });
}

/*
    GITHUB WEBHOOK LISTENER
*/

const webhooks = new Webhooks({
    secret: config.secret,
});

webhooks.onAny(({ id, name, payload }) => {
    if (name !== 'push') {
        // log unsupported webhook types
        logReception(name, payload, true);
    }
});

webhooks.on('push', async ({ id, name, payload }) => {
    const index = submoduleRepos.indexOf(payload.repository.name);

    if (index >= 0) {
        // submodule is monitored
        const ref = payload.ref;
        const submodule = submodules[index];

        if (ref == 'refs/heads/' + submodule.moduleBranch) {
            // submodule branch is monitored
            logReception(name, payload);

            try {
                // create new commit in parent repo
                const parentHEAD = await getParentHEAD(submodule);
                const tree = await createTree(submodule, payload.after, parentHEAD.commit.tree.sha);
                const commit = await createCommit(
                    submodule,
                    tree.sha,
                    payload.after,
                    parentHEAD.sha
                );

                // update parent repo
                await updateRef(submodule, commit.sha);
            } catch (error) {
                logError(error);
                log(
                    `NOT UPDATED - submodule is still at (${payload.before})`,
                    submodule.parentRepo
                );
                return;
            }
            log(
                `UPDATED submodule ${config.owner}/${submodule.moduleRepo} to (${payload.after})`,
                submodule.parentRepo
            );
        } else {
            // submodule branch is not monitored
            logReception(name, payload, true);
        }
    } else {
        // submodule is not monitored
        logReception(name, payload, true);
    }
});

// Server
require('http').createServer(webhooks.middleware).listen(3000);

/*
    UTILITIES
*/

function shortenSHAs(str) {
    const matches = str.matchAll(/\(\w+?\)/g);
    for (const match of matches) {
        str = str.replace(match[0], match[0].substring(0, 8) + ')');
    }
    return str;
}

function log(msg, repoName = '') {
    if (repoName) msg = `${config.owner}/${repoName}: ${msg}`;
    console.log(shortenSHAs(msg));
    logfile.log('info', msg);
}

function logReception(name, payload, minor = false) {
    const origin = payload.repository.full_name;
    const separator = origin === '' ? '' : ': ';
    const msg = origin + separator + `Received ${name.toUpperCase()} event (${payload.after})`;
    logfile.log('info', msg);
    if (minor) {
        console.log('\x1b[2m' + msg + '\x1b[0m');
    } else {
        console.log(msg);
    }
}

function logError(error) {
    console.log('\x1b[31m' + error.stack + '\x1b[0m');
    logfile.log('error', error.stack);
}

function logDebug(msg) {
    if (config.debug) {
        console.log(msg);
        logfile.log('debug', msg);
    }
}
