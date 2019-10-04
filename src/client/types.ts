export interface IExpoNotificationParts {
  data: any
}

export type IGetExpoToken = () => PromiseLike<string>

export interface IExpoTransportOptions {
  address: string
  getToken: IGetExpoToken
}
