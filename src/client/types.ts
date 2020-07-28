import * as Notifications from 'expo-notifications'
import { INotificationControl } from '@consento/api'

export interface IExpoNotificationParts {
  data: any
}

export type IGetExpoToken = () => Promise<Notifications.ExpoPushToken>

export interface IExpoTransportOptions {
  address?: string
  getToken?: IGetExpoToken
  control: INotificationControl
}
