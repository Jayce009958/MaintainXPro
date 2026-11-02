document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("deleteModal");
  const modalMessage = document.getElementById("deleteModalMessage");
  const cancelButton = document.getElementById("cancelDelete");
  const confirmButton = document.getElementById("confirmDelete");

  let pendingForm = null;

  if (!modal) return;

  // Open the confirmation popup
  document.addEventListener("submit", (event) => {
    const form = event.target;

    if (!form.classList.contains("delete-confirm-form")) {
      return;
    }

    event.preventDefault();

    pendingForm = form;

    modalMessage.textContent =
      form.dataset.deleteMessage ||
      "Are you sure you want to delete this record?";

    modal.classList.add("active");
  });

  // Cancel deletion
  cancelButton.addEventListener("click", () => {
    modal.classList.remove("active");
    pendingForm = null;
  });

  // Confirm deletion
  confirmButton.addEventListener("click", () => {
    if (pendingForm) {
      HTMLFormElement.prototype.submit.call(pendingForm);
    }
  });

  // Close popup when clicking outside
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      modal.classList.remove("active");
      pendingForm = null;
    }
  });

  // Close popup using Escape key
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("active")) {
      modal.classList.remove("active");
      pendingForm = null;
    }
  });
});
