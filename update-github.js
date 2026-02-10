window.glide = async function(jsonData, githubToken, repoOwner, repoName) {
  if (!jsonData) return "No data";

  const filePath = "data.json"; // Path in your repo
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;

  try {
    // 1. Get the current file SHA (required to update existing files)
    const getFile = await fetch(url, {
      headers: { "Authorization": `Bearer ${githubToken}` }
    });
    
    let sha = "";
    if (getFile.ok) {
      const fileData = await getFile.json();
      sha = fileData.sha;
    }

    // 2. Update the file
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update data.json from Glide",
        content: btoa(jsonData), // GitHub requires Base64 encoding
        sha: sha // Include SHA if the file already exists
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return "Error: " + err.message;
    }

    return "Success: " + new Date().toLocaleTimeString();
  } catch (e) {
    return "Failed: " + e.message;
  }
};
