const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const mqtt = require('mqtt');
const fs = require('fs');
const { contains } = require('./helpers.util');
const { SERVER, MQTT, FRIGATE, CAMERAS } = require('../constants');

let PREVIOUS_MQTT_LENGTHS = [];
let JUST_SUBSCRIBED = false;
let CLIENT = false;
const PERSON_RESET_TIMEOUT = {};

const cameraTopics = () => {
  return CAMERAS
    ? Object.keys(CAMERAS)
        .filter((key) => CAMERAS[key].SNAPSHOT && CAMERAS[key].SNAPSHOT.TOPIC)
        .map((key) => {
          return CAMERAS[key].SNAPSHOT.TOPIC;
        })
    : [];
};

const processMessage = ({ topic, message }) => {
  const init = async () => {
    if ((topic.includes('/snapshot') || cameraTopics().includes(topic)) && !JUST_SUBSCRIBED)
      await processMessage({ topic, message }).snapshot();
    if (topic.includes('/events')) await processMessage({ topic, message }).frigate();
  };

  const snapshot = async () => {
    const camera = topic.split('/')[1];
    const filename = `${uuidv4()}.jpg`;
    const buffer = Buffer.from(message);

    if (PREVIOUS_MQTT_LENGTHS.includes(buffer.length)) {
      return;
    }
    PREVIOUS_MQTT_LENGTHS.unshift(buffer.length);

    fs.writeFileSync(`/tmp/${filename}`, buffer);
    await axios({
      method: 'get',
      url: `http://0.0.0.0:${SERVER.PORT}/api/recognize`,
      params: {
        url: `http://0.0.0.0:${SERVER.PORT}/api/tmp/${filename}`,
        type: 'mqtt',
        camera,
      },
      validateStatus() {
        return true;
      },
    });
    // only store last 10 mqtt lengths
    PREVIOUS_MQTT_LENGTHS = PREVIOUS_MQTT_LENGTHS.slice(0, 10);
  };

  const frigate = async () => {
    await axios({
      method: 'post',
      url: `http://0.0.0.0:${SERVER.PORT}/api/recognize`,
      data: {
        ...JSON.parse(message.toString()),
      },
      validateStatus() {
        return true;
      },
    });
  };

  return { init, snapshot, frigate };
};

module.exports.connect = () => {
  if (!MQTT.HOST) {
    return;
  }
  CLIENT = mqtt.connect(`mqtt://${MQTT.HOST}`, {
    reconnectPeriod: 10000,
    username: MQTT.USERNAME,
    password: MQTT.PASSWORD,
  });

  CLIENT.on('connect', () => {
    console.log('MQTT: connected');
    this.available('online');
    this.subscribe();
  })
    .on('error', (err) => console.error(`MQTT: ${err.code}`))
    .on('offline', () => console.error('MQTT: offline'))
    .on('disconnect', () => console.error('MQTT: disconnected'))
    .on('reconnect', () => console.warn('MQTT: attempting to reconnect'))
    .on('message', async (topic, message) => processMessage({ topic, message }).init());
};

module.exports.available = async (state) => {
  if (CLIENT) this.publish({ topic: 'double-take/available', message: state });
};

module.exports.subscribe = () => {
  const topics = [];

  topics.push(...cameraTopics());

  if (FRIGATE.URL && MQTT.TOPICS.FRIGATE) {
    const isArray = Array.isArray(MQTT.TOPICS.FRIGATE);

    const frigateTopics = isArray ? MQTT.TOPICS.FRIGATE : [MQTT.TOPICS.FRIGATE];
    topics.push(...frigateTopics);
    frigateTopics.forEach((topic) => {
      const [prefix] = topic.split('/');
      topics.push(
        ...(FRIGATE.CAMERAS
          ? FRIGATE.CAMERAS.map((camera) => `${prefix}/${camera}/person/snapshot`)
          : [`${prefix}/+/person/snapshot`])
      );
    });
  }

  if (topics.length) {
    CLIENT.subscribe(topics, (err) => {
      if (err) {
        console.error(`MQTT: error subscribing to ${topics.join(', ')}`);
        return;
      }
      console.log(`MQTT: subscribed to ${topics.join(', ')}`);
      JUST_SUBSCRIBED = true;
      setTimeout(() => (JUST_SUBSCRIBED = false), 5000);
    });
  }
};

module.exports.recognize = (data) => {
  try {
    if (!MQTT || !MQTT.HOST) return;
    const { matches, unknown, camera } = data;
    const hasUnkown = unknown && Object.keys(unknown).length;

    const configData = JSON.parse(JSON.stringify(data));
    delete configData.matches;
    delete configData.unknown;
    delete configData.results;

    const messages = [];

    let personCount = matches.length ? matches.length : hasUnkown ? 1 : 0;
    // check to see if unknown bounding box is contained within or contains any of the match bounding boxes
    // if false, then add 1 to the person count
    if (matches.length && hasUnkown) {
      let unknownContained = false;
      matches.forEach((match) => {
        if (contains(match.box, unknown.box) || contains(unknown.box, match.box))
          unknownContained = true;
      });
      if (!unknownContained) personCount += 1;
    }

    messages.push({
      topic: `${MQTT.TOPICS.CAMERAS}/${camera}/person`,
      message: personCount.toString(),
    });

    if (hasUnkown) {
      messages.push({
        topic: `${MQTT.TOPICS.MATCHES}/unknown`,
        message: JSON.stringify({
          ...configData,
          unknown,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/unknown/config`,
          message: JSON.stringify({
            name: 'unknown',
            icon: 'mdi:account',
            value_template: '{{ value_json.camera }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/unknown/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/unknown/state`,
            availability_topic: 'double-take/available',
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/unknown/state`,
          message: JSON.stringify({
            ...configData,
            unknown,
          }),
        });
      }
    }

    matches.forEach((match) => {
      messages.push({
        topic: `${MQTT.TOPICS.MATCHES}/${match.name}`,
        message: JSON.stringify({
          ...configData,
          match,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${match.name}/config`,
          message: JSON.stringify({
            name: match.name,
            icon: 'mdi:account',
            value_template: '{{ value_json.camera }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${match.name}/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${match.name}/state`,
            availability_topic: 'double-take/available',
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${match.name}/state`,
          message: JSON.stringify({
            ...configData,
            match,
          }),
        });
      }
    });

    if (matches.length || hasUnkown) {
      messages.push({
        topic: `${MQTT.TOPICS.CAMERAS}/${camera}`,
        message: JSON.stringify({
          ...configData,
          matches,
          unknown,
        }),
      });

      if (MQTT.TOPICS.HOMEASSISTANT) {
        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${camera}/config`,
          message: JSON.stringify({
            name: camera,
            icon: 'mdi:camera',
            value_template: '{{ value_json.personCount }}',
            state_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${camera}/state`,
            json_attributes_topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${camera}/state`,
            availability_topic: 'double-take/available',
          }),
        });

        messages.push({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${camera}/state`,
          message: JSON.stringify({
            ...configData,
            matches,
            unknown,
            personCount,
          }),
        });
      }
    }

    this.publish(messages);

    clearTimeout(PERSON_RESET_TIMEOUT[camera]);
    PERSON_RESET_TIMEOUT[camera] = setTimeout(() => {
      this.publish({ topic: `${MQTT.TOPICS.CAMERAS}/${camera}/person`, message: '0' });
      if (MQTT.TOPICS.HOMEASSISTANT) {
        this.publish({
          topic: `${MQTT.TOPICS.HOMEASSISTANT}/sensor/${camera}/state`,
          message: JSON.stringify({
            ...configData,
            matches,
            unknown,
            personCount: 0,
          }),
        });
      }
    }, 30000);
  } catch (error) {
    console.error(`MQTT: recognize error: ${error.message}`);
  }
};

module.exports.publish = (data) => {
  const multiple = Array.isArray(data);
  const single = data && !multiple && typeof data === 'object';

  if (!single && !multiple) console.error('MQTT: publish error');

  const messages = single ? [{ ...data }] : data;
  messages.forEach((message) => CLIENT.publish(message.topic, message.message, { retain: true }));
};
