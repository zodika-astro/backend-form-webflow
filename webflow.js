<script>
    let currentStep = 0;
    const steps = document.querySelectorAll(".natal-step");
    const form = document.getElementById("natalForm");
    const progressSteps = document.querySelectorAll(".progress-step");
    const spinner = document.getElementById("spinner");
    const errorMessage = document.getElementById("errorMessage");
    let cityValidated = false;
    let selectedCity = "";

    function updateProgress() {
        progressSteps.forEach((step, index) => {
            step.classList.toggle("active", index <= currentStep);
        });
    }

    function showStep(index) {
        steps.forEach((step, i) => {
            step.style.display = i === index ? "flex" : "none";
            if (i === index) {
                requestAnimationFrame(() => {
                    const input = step.querySelector("input");
                    if (input) input.focus({ preventScroll: true });
                });
            }
        });
        updateProgress();
    }

    function showError(element, message) {
        const errorElement = document.getElementById(element);
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.display = "block";
            errorElement.setAttribute("role", "alert");
        }
    }

    function hideError(element) {
        const errorElement = document.getElementById(element);
        if (errorElement) {
            errorElement.style.display = "none";
            errorElement.removeAttribute("role");
        }
    }

    function validateDate(input) {
        const inputDate = new Date(input.value);
        const now = new Date();
        const minDate = new Date("1700-01-01");

        if (isNaN(inputDate.getTime())) {
            showError("dateError", "por favor, insira uma data válida.");
            return false;
        }
        if (inputDate < minDate) {
            showError("dateError", "a data não pode ser anterior a 1700.");
            return false;
        }
        if (inputDate > now) {
            showError("dateError", "a data não pode ser no futuro.");
            return false;
        }
        return true;
    }

    function validateCity(input) {
        if (!cityValidated) {
            showError("cityError", "por favor, selecione uma cidade válida da lista.");
            input.classList.add("invalid");
            input.setAttribute("aria-invalid", "true");
            return false;
        }
        input.classList.remove("invalid");
        input.removeAttribute("aria-invalid");
        hideError("cityError");
        return true;
    }

    function validateInputs(inputs) {
        let allValid = true;
        inputs.forEach((input) => {
            input.classList.remove("invalid");
            input.removeAttribute("aria-invalid");
            hideError(`${input.name}Error`);

            if (!input.checkValidity()) {
                input.classList.add("invalid");
                input.setAttribute("aria-invalid", "true");
                allValid = false;
                if (input.name === "name") {
                    showError("nameError", "por favor, preencha seu nome completo.");
                }
                if (input.name === "email") {
                    showError("emailError", "por favor, insira um e-mail válido.");
                }
            }

            if (input.name === "birth_date" && !validateDate(input)) {
                input.classList.add("invalid");
                input.setAttribute("aria-invalid", "true");
                allValid = false;
            }

            if (input.name === "birth_place" && !validateCity(input)) {
                allValid = false;
            }
        });
        return allValid;
    }

    function nextStep() {
        const currentInputs = steps[currentStep].querySelectorAll("input");
        if (!validateInputs(currentInputs)) return;

        if (currentStep < steps.length - 1) {
            currentStep++;
            if (currentStep === steps.length - 1) {
                fillConfirmation();
            }
            showStep(currentStep);
        }
    }

    function fillConfirmation() {
        const formData = new FormData(form);
        const summaryDiv = document.getElementById("confirmation-summary");
        const labels = {
            name: "NOME",
            social_name: "NOME-SOCIAL",
            email: "EMAIL",
            birth_date: "DATA DE NASCIMENTO",
            birth_time: "HORA DE NASCIMENTO",
            birth_place: "CIDADE DE NASCIMENTO",
        };

        let summaryHTML = "<ul style='padding-left: 0; list-style: none;'>";
        for (const [key, label] of Object.entries(labels)) {
            let value = formData.get(key) || "(não informado)";
            if (key === "birth_date" && value) {
                const dateObj = new Date(value);
                if (!isNaN(dateObj)) {
                    const day = String(dateObj.getDate()).padStart(2, "0");
                    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
                    const year = dateObj.getFullYear();
                    value = `${day}/${month}/${year}`;
                }
            }
            summaryHTML += `<li><strong>${label}:</strong> ${value}</li>`;
        }
        summaryHTML += "</ul>";
        summaryDiv.innerHTML = summaryHTML;
    }

    function prevStep() {
        if (currentStep > 0) {
            currentStep--;
            showStep(currentStep);
        }
    }

    function resetForm() {
        form.reset();
        currentStep = 0;
        cityValidated = false;
        selectedCity = "";
        steps.forEach((step) => (step.style.display = "none"));
        steps[0].style.display = "flex";
        errorMessage.style.display = "none";
        spinner.style.display = "none";
        updateProgress();
    }

      /** ======= GOOGLE AUTOCOMPLETE (classic JS API) ======= */
      window.initAutocomplete = function () {
        var cityInput = document.getElementById('cityInput');
        if (!cityInput || !google || !google.maps || !google.maps.places) return;

        var autocomplete = new google.maps.places.Autocomplete(cityInput, {
          types: ['(cities)']
        });

        // Request only the fields we need (reduces payload)
        autocomplete.setFields(['place_id','name','formatted_address','address_components','geometry']);

        autocomplete.addListener('place_changed', function () {
          var place = autocomplete.getPlace();

          if (!place || !place.place_id || !place.geometry || !place.geometry.location) {
            window.cityValidated = false;
            cityInput.classList.add("invalid");
            cityInput.setAttribute("aria-invalid","true");
            showError("cityError", "por favor, selecione uma cidade válida da lista.");
            return;
          }

          var comps = place.address_components || [];
          function get(type) {
            var c = comps.find(function(ac){ return (ac.types||[]).indexOf(type) !== -1; });
            return c ? (c.short_name || c.long_name || '') : '';
          }

           var country = get('country');
          var admin1  = get('administrative_area_level_1');
          var admin2  = get('administrative_area_level_2');

          var lat = place.geometry.location.lat();
          var lng = place.geometry.location.lng();

          // Human-readable label for your original birth_place field
          var display = [place.name || admin2 || '', admin1, country].filter(Boolean).join(', ');

          // Keep your existing behavior
          window.selectedCity  = display;
          window.cityValidated = true;

          // Fill hidden inputs
          document.getElementById('birth_place_place_id').value = place.place_id;
          document.getElementById('birth_place_full').value     = place.formatted_address || display;
          document.getElementById('birth_place_country').value  = country;
          document.getElementById('birth_place_admin1').value   = admin1;
          document.getElementById('birth_place_admin2').value   = admin2;
          document.getElementById('birth_place_lat').value      = String(lat);
          document.getElementById('birth_place_lng').value      = String(lng);
          document.getElementById('birth_place_json').value     = JSON.stringify({
            place_id: place.place_id,
            formatted_address: place.formatted_address,
            name: place.name,
            address_components: place.address_components
          });

          // Clear any error visuals
          cityInput.classList.remove("invalid");
          cityInput.removeAttribute("aria-invalid");
          hideError("cityError");
        });

          cityInput.addEventListener('input', function(){
            if (cityInput.value !== window.selectedCity) window.cityValidated = false;
        });
      };

    form.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            nextStep();
        }
    });

    form.addEventListener("submit", async function (e) {
        e.preventDefault();

        const currentInputs = steps[currentStep].querySelectorAll("input");
        if (!validateInputs(currentInputs)) return;

        steps.forEach((step) => (step.style.display = "none"));
        spinner.style.display = "flex";

        const formData = Object.fromEntries(new FormData(this).entries());
        formData.birth_place = selectedCity;
        formData.product_type = "birth_chart";

        try {
        		const response = await fetch("https://backend-form-webflow-production.up.railway.app/birthchart/birthchartsubmit-form", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(formData),
            });

            if (!response.ok) throw new Error("erro ao criar pagamento");

            const data = await response.json();

            if (data.url) {
                window.location.href = data.url;
            } else {
                throw new Error("URL de pagamento não recebida");
            }
        } catch (error) {
            console.error("Erro:", error);
            spinner.style.display = "none";
            errorMessage.style.display = "flex";
        }
    });

    window.onload = function () {
        showStep(0);
    };
</script>

<script async src="https://maps.googleapis.com/maps/api/js?key=AIzaSyAC0DDDTO5D52LscJmIui2V2K6FJcFjPII&libraries=places&v=weekly&loading=async&callback=initAutocomplete"></script>

