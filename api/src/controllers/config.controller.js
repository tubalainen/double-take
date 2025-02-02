const fs = require('fs');
const yaml = require('js-yaml');
const redact = require('../util/redact-secrets.util');
const config = require('../constants/config');
const { ui } = require('../constants/ui');
const { BAD_REQUEST } = require('../constants/http-status');
const { STORAGE } = require('../constants')();

module.exports.get = async (req, res) => {
  const { format } = req.query;
  const isLegacyPath = fs.existsSync('./config.yml');
  let output = {};
  if (format === 'yaml')
    output = fs.readFileSync(
      isLegacyPath ? './config.yml' : `${STORAGE.CONFIG.PATH}/config.yml`,
      'utf8'
    );
  else if (format === 'yaml-with-defaults') output = yaml.dump(config());
  else if (req.query.redact === '') output = redact(config());
  else output = config();
  res.send(output);
};

module.exports.theme = {
  get: async (req, res) => {
    const settings = config();
    res.send({ theme: settings.ui.theme, editor: settings.ui.editor });
  },
  patch: (req, res) => {
    const { ui: theme, editor } = req.body;
    ui.set({ theme, editor: { theme: editor } });
    config.set.ui({ theme, editor: { theme: editor } });
    res.send();
  },
};

module.exports.patch = async (req, res) => {
  try {
    const isLegacyPath = fs.existsSync('./config.yml');
    const { code } = req.body;
    yaml.load(code);
    fs.writeFileSync(isLegacyPath ? './config.yml' : `${STORAGE.CONFIG.PATH}/config.yml`, code);
    res.send();
  } catch (error) {
    if (error.name === 'YAMLException') return res.status(BAD_REQUEST).send(error);
    res.send(error);
  }
};
