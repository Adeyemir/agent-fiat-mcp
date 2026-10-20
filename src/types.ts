export interface BankInput {
  bank: string;
  accountNumber: string;
  expectedName: string;
}
export interface BankAccount {
  bankId: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  bankCode?: string;
}
export type BankApproval = (bank: {
  name: string;
  bank: string;
  accountNumber: string;
}) => Promise<boolean>;
