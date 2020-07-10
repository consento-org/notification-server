import * as Notifications from 'expo-notifications'

export interface IExpoNotificationParts {
  data: any
}

export type IGetExpoToken = () => Promise<Notifications.ExpoPushToken>

export interface IExpoTransportOptions {
  address?: string
  getToken?: IGetExpoToken
}
