import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import Parse from "parse";
import logo from "../assets/images/logo.png";
import Loader from "../primitives/Loader";
import Alert from "../primitives/Alert";

function PublicSign() {
  const { templateId } = useParams();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [templateName, setTemplateName] = useState("");
  const [templateDesc, setTemplateDesc] = useState("");
  const [alert, setAlert] = useState({ type: "", msg: "" });

  useEffect(() => {
    loadTemplate();
  }, []);

  const loadTemplate = async () => {
    try {
      const result = await Parse.Cloud.run("getPublicTemplate", { templateId });
      setTemplateName(result.name);
      setTemplateDesc(result.description);
    } catch (err) {
      setAlert({ type: "danger", msg: "Document not found or no longer available." });
    }
    setPageLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;

    setLoading(true);
    setAlert({ type: "", msg: "" });

    try {
      const result = await Parse.Cloud.run("createPublicSigningDoc", {
        templateId,
        signerName: name.trim(),
        signerEmail: email.trim().toLowerCase(),
      });

      if (result?.signingUrl) {
        navigate(result.signingUrl);
      } else {
        setAlert({ type: "danger", msg: "Something went wrong. Please try again." });
        setLoading(false);
      }
    } catch (err) {
      console.error("Public sign error:", err);
      setAlert({ type: "danger", msg: err.message || "Something went wrong." });
      setLoading(false);
    }
  };

  if (pageLoading) {
    return (
      <div className="fixed w-full h-full flex justify-center items-center">
        <Loader />
      </div>
    );
  }

  return (
    <div className="flex justify-center items-center min-h-screen bg-base-200 p-4">
      <div className="w-full max-w-md bg-base-100 rounded-lg shadow-lg p-8">
        <div className="flex justify-center mb-6">
          <img src={logo} alt="Logo" className="h-12" />
        </div>

        {templateName && (
          <div className="text-center mb-6">
            <h1 className="text-xl font-semibold">{templateName}</h1>
            {templateDesc && (
              <p className="text-sm text-gray-500 mt-1">{templateDesc}</p>
            )}
          </div>
        )}

        <p className="text-sm text-center text-gray-600 mb-6">
          Enter your details below to review and sign this document.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1" htmlFor="name">
              Full Name
            </label>
            <input
              id="name"
              type="text"
              className="op-input op-input-bordered w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your full name"
              required
              disabled={loading}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium mb-1" htmlFor="email">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              className="op-input op-input-bordered w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="op-btn op-btn-primary w-full"
            disabled={loading || !templateName}
          >
            {loading ? "Preparing document..." : "Continue to Sign"}
          </button>
        </form>

        {alert.msg && (
          <div className="mt-4">
            <Alert type={alert.type}>{alert.msg}</Alert>
          </div>
        )}

        <p className="text-xs text-center text-gray-400 mt-6">
          Powered by OpenSign
        </p>
      </div>
    </div>
  );
}

export default PublicSign;
