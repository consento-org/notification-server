export interface IExpoNotificationParts {
  data: any
}

export interface IExpoNotificationsParts {
  addListener(listener: (message: IExpoNotificationParts) => void): any
  getExpoPushTokenAsync(): Promise<string>
}

export interface IExpoGetTokenOptions {
  expo: IExpoNotificationsParts
}

export type IGetExpoToken = (options: IExpoGetTokenOptions) => PromiseLike<string>

export interface IExpoTransportOptions {
  address: string
  expo: IExpoNotificationsParts
  getToken?: IGetExpoToken
}
