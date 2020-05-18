export interface IExpoNotificationParts {
  data: any
}

export type IGetExpoToken = () => Promise<string>

export interface IExpoTransportOptions {
  address: string
  getToken?: IGetExpoToken
}
