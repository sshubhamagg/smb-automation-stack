export interface CommunicationAdapter {
  send(to: string, message: string): Promise<void>;
}
