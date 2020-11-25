const { Rest } = require('@octokit/rest');
const { Webhooks } = require('@octokit/webhooks');

const webhooks = new Webhooks({
    secret: 'mysecret',
});
