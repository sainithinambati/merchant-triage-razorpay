import NewTicketForm from "./NewTicketForm";

export default function NewTicketPage() {
  return (
    <>
      <h1>New test ticket</h1>
      <p className="sub">Create a ticket as if it came from a merchant, then watch it move through the pipeline.</p>
      <NewTicketForm />
    </>
  );
}
