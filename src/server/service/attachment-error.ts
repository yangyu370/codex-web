export class AttachmentError extends Error {
  constructor(
    public readonly code:
      | "invalidAttachment"
      | "attachmentTooLarge"
      | "attachmentCapacity"
      | "attachmentExpired",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}
