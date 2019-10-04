# @consento/notification-server

The `@consento/notification-server` is a [expo](https://expo.io) based notification implementation for Consento.
It consists of two parts: The Server & The Client.

## Why?

Consento is supposed to run as decentralized as possible. Initially the decentralization of the notification
system is not just a lot of work _(please contact us if you want to support implement this)_ but also a risk
in the current development phase. For that reason we are using [Expo Push Notifications][1] in the current
version of Consento.

[1]: https://docs.expo.io/versions/v34.0.0/guides/push-notifications/#push-notifications

## The Server

### Rationale

Expo has one push-token per device/app! If this were to be directly shared with other devices, they would be able to
spam/send the device without the possibility to for the other device to stop listening to these notifications. 

The centralized server also open the possibility to later implement other notification systems that run on the same
system. i.e. a decentralized system or desktop system that has different requirements.

### Start the server

You can start the server using:

```bash
npx @consento/notification-server
```

It will log any messages as json to stdout.

You can change the port using `env PORT=8080 npx @consento/notification-server`

### Storage

The server persists the current state in a [HyperDB](https://github.com/mafintosh/hyper-db)
instance. This system could in future be used to distribute the state over multiple instances
of the notification server running on different devices.

## The Client

The client implements the `INotificationTransport` interface of `@consento/api`. It can be
setup as follows:

```javascript
const { ExpoTransport } = require('@consento/notification-server')
const { setup } = require('@consento/api')
const { sodium } = require('@consento/crypto/core/sodium')

const api = setup({
  cryptoCore: sodium,
  notificationTransport: new ExpoTransport({
    address: 'https://server.com/api', // insert the root of the running notification-server here
    expo: Expo()
  })
})
```

With this API you can send/receive notifications like this:

```javascript
const sender = api.Sender.create()
const receiver = sender.newReceiver()

api.notifications.on('message', (receiver/*: IReceiver*/, message) => {
  console.log('hello world')
})
api.notifications.subscribe(receiver) // Usually this happens on a different device
api.notifications.send(sender, 'Hello World')
```

## License

[MIT](./LICENSE)
